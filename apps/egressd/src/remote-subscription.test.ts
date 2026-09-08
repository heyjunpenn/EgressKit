import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { type MihomoRuntime, startEgressd } from "./daemon.js";
import { openControlState } from "./state.js";

const VALID_SUBSCRIPTION = `proxies:
  - { name: remote, type: vless, server: proxy.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`;

interface OperationBody extends Record<string, unknown> {
  failure?: { reason: string; stage: string };
  history?: string[];
  operationId?: string;
  status?: string;
  subscriptionId?: string;
}

test("remote subscription operations expose every successful processing stage and can refresh", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const applied: unknown[] = [];
  const fetches: string[] = [];
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (url) => {
      fetches.push(url);
      return new Response(VALID_SUBSCRIPTION, { status: 200 });
    },
    host: "127.0.0.1",
    mihomoRuntime: successfulRuntime(applied),
    port: 0,
    stateDirectory,
  });
  t.after(() => daemon.close());

  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/subscription?token=secret" },
    method: "POST",
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.status, "queued");
  assert.equal(JSON.stringify(created.body).includes("token=secret"), false);
  const first = await waitForTerminalOperation(daemon.address, created.body.operationId as string);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.history, [
    "queued",
    "fetching",
    "parsing",
    "validating",
    "applying",
    "checking",
    "succeeded",
  ]);

  const refreshed = await adminJson(
    daemon.address,
    `/subscriptions/${created.body.subscriptionId as string}/refresh`,
    { method: "POST" },
  );
  assert.equal(refreshed.status, 202);
  assert.notEqual(refreshed.body.operationId, created.body.operationId);
  const second = await waitForTerminalOperation(
    daemon.address,
    refreshed.body.operationId as string,
  );
  assert.equal(second.body.status, "succeeded");
  assert.equal(fetches.length, 2);
  assert.equal(applied.length, 2);
});

test("a first fetch failure remains queryable without losing the original URL", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (url) => {
      throw new Error(`HTTP 503 while fetching ${url}`);
    },
    host: "127.0.0.1",
    mihomoRuntime: successfulRuntime([]),
    port: 0,
    stateDirectory,
  });
  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/failing?token=still-saved" },
    method: "POST",
  });
  const failed = await waitForTerminalOperation(daemon.address, created.body.operationId as string);
  assert.equal(failed.body.status, "failed");
  assert.equal(failed.body.failure?.stage, "fetching");
  assert.match(failed.body.failure?.reason ?? "", /503/);
  assert.doesNotMatch(failed.body.failure?.reason ?? "", /token=still-saved/);
  await daemon.close();

  const state = await openControlState(stateDirectory);
  t.after(() => state.close());
  assert.equal(
    state.getSubscription(created.body.subscriptionId as string)?.locator,
    "https://provider.example/failing?token=still-saved",
  );
});

test("operation failures identify the exact processing stage", async (t) => {
  const cases: Array<{
    expectedStage: string;
    runtime: MihomoRuntime;
    source: string;
  }> = [
    {
      expectedStage: "parsing",
      runtime: successfulRuntime([]),
      source: "proxies: [",
    },
    {
      expectedStage: "validating",
      runtime: successfulRuntime([]),
      source: "proxies: [{ name: invalid, type: vless }]",
    },
    {
      expectedStage: "applying",
      runtime: { apply: async () => Promise.reject(new Error("runtime rejected config")) },
      source: VALID_SUBSCRIPTION,
    },
    {
      expectedStage: "checking",
      runtime: { apply: async () => new Map() },
      source: VALID_SUBSCRIPTION,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.expectedStage, async (subtest) => {
      const stateDirectory = await temporaryStateDirectory(subtest);
      const daemon = await startEgressd({
        adminToken: "admin-token",
        fetchSubscription: async () => new Response(scenario.source),
        host: "127.0.0.1",
        mihomoRuntime: scenario.runtime,
        port: 0,
        stateDirectory,
      });
      subtest.after(() => daemon.close());
      const created = await adminJson(daemon.address, "/subscriptions/remote", {
        body: { url: `https://provider.example/${scenario.expectedStage}` },
        method: "POST",
      });
      const failed = await waitForTerminalOperation(
        daemon.address,
        created.body.operationId as string,
      );
      assert.equal(failed.body.status, "failed");
      assert.equal(failed.body.failure?.stage, scenario.expectedStage);
    });
  }
});

test("daemon restart marks unfinished operations as interrupted", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const first = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (_url, { signal }) =>
      new Promise<Response>((_resolve, reject) => {
        markFetchStarted?.();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    host: "127.0.0.1",
    port: 0,
    stateDirectory,
  });
  const queued = await adminJson(first.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/pending" },
    method: "POST",
  });
  await fetchStarted;
  await first.close();

  const daemon = await startEgressd({
    adminToken: "admin-token",
    host: "127.0.0.1",
    port: 0,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const operation = await adminJson(
    daemon.address,
    `/operations/${queued.body.operationId as string}`,
  );

  assert.equal(operation.status, 200);
  assert.equal(operation.body.status, "interrupted");
  assert.deepEqual(operation.body.history, ["queued", "fetching", "interrupted"]);
});

function successfulRuntime(applied: unknown[]): MihomoRuntime {
  return {
    apply: async (config) => {
      applied.push(config);
      return new Map([["remote", new URL("http://127.0.0.1:20000")]]);
    },
  };
}

async function temporaryStateDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-remote-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function adminJson(
  address: { host: string; port: number },
  path: string,
  options: { body?: unknown; method?: string } = {},
): Promise<{ body: OperationBody; status: number }> {
  const response = await fetch(`http://${address.host}:${address.port}${path}`, {
    ...(options.method === undefined ? {} : { method: options.method }),
    headers: {
      authorization: "Bearer admin-token",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    body: (await response.json()) as OperationBody,
    status: response.status,
  };
}

async function waitForTerminalOperation(
  address: { host: string; port: number },
  operationId: string,
): Promise<{ body: OperationBody; status: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await adminJson(address, `/operations/${operationId}`);
    if (["succeeded", "failed", "interrupted"].includes(operation.body.status as string)) {
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`operation ${operationId} did not finish`);
}
