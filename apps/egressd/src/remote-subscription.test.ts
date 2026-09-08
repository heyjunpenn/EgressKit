import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
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
  const fixture = await startSubscriptionFixture(t, (_response) => ({
    body: VALID_SUBSCRIPTION,
    status: 200,
  }));
  const daemon = await startEgressd({
    adminToken: "admin-token",
    checkMihomoListener: async () => undefined,
    fetchSubscription: async (url, options) => {
      fetches.push(url);
      return fetch(fixture, options);
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

test("remote operations are serialized in creation order", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const fixture = await startSubscriptionFixture(t, (response) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    response.writeHead(200);
    setTimeout(() => {
      activeRequests -= 1;
      response.end(VALID_SUBSCRIPTION);
    }, 20);
    return undefined;
  });
  const daemon = await startEgressd({
    adminToken: "admin-token",
    checkMihomoListener: async () => undefined,
    fetchSubscription: async (_url, options) => fetch(fixture, options),
    host: "127.0.0.1",
    mihomoRuntime: successfulRuntime([]),
    port: 0,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/ordered" },
    method: "POST",
  });
  await waitForTerminalOperation(daemon.address, created.body.operationId as string);

  const firstRefresh = await adminJson(
    daemon.address,
    `/subscriptions/${created.body.subscriptionId as string}/refresh`,
    { method: "POST" },
  );
  const secondRefresh = await adminJson(
    daemon.address,
    `/subscriptions/${created.body.subscriptionId as string}/refresh`,
    { method: "POST" },
  );
  await Promise.all([
    waitForTerminalOperation(daemon.address, firstRefresh.body.operationId as string),
    waitForTerminalOperation(daemon.address, secondRefresh.body.operationId as string),
  ]);

  assert.equal(maximumActiveRequests, 1);
});

test("a hung source times out without permanently blocking later operations", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let requestNumber = 0;
  const fixture = await startSubscriptionFixture(t, (response) => {
    requestNumber += 1;
    if (requestNumber === 1) {
      response.writeHead(200);
      response.flushHeaders();
      return undefined;
    }
    return { body: VALID_SUBSCRIPTION, status: 200 };
  });
  const daemon = await startEgressd({
    adminToken: "admin-token",
    checkMihomoListener: async () => undefined,
    fetchSubscription: async (_url, options) => fetch(fixture, options),
    host: "127.0.0.1",
    mihomoRuntime: successfulRuntime([]),
    port: 0,
    remoteSubscriptionTimeoutMs: 20,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const first = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/hung" },
    method: "POST",
  });
  const second = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/healthy" },
    method: "POST",
  });

  const [timedOut, succeeded] = await Promise.all([
    waitForTerminalOperation(daemon.address, first.body.operationId as string),
    waitForTerminalOperation(daemon.address, second.body.operationId as string),
  ]);
  assert.equal(timedOut.body.failure?.reason, "remote subscription request timed out");
  assert.equal(succeeded.body.status, "succeeded");
});

test("a first fetch failure remains queryable without losing the original URL", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const fixture = await startSubscriptionFixture(t, () => ({ body: "unavailable", status: 503 }));
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (_url, options) => fetch(fixture, options),
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
      runtime: {
        apply: async () => new Map([["remote", new URL("http://127.0.0.1:20000")]]),
      },
      source: VALID_SUBSCRIPTION,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.expectedStage, async (subtest) => {
      const stateDirectory = await temporaryStateDirectory(subtest);
      const fixture = await startSubscriptionFixture(subtest, () => ({
        body: scenario.source,
        status: 200,
      }));
      const daemon = await startEgressd({
        adminToken: "admin-token",
        ...(scenario.expectedStage === "checking"
          ? {
              checkMihomoListener: async () =>
                Promise.reject(new Error("listener is not accepting connections")),
            }
          : {}),
        fetchSubscription: async (_url, options) => fetch(fixture, options),
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
  const hangingFixture = await startSubscriptionFixture(t, (response) => {
    markFetchStarted?.();
    response.writeHead(200);
    response.flushHeaders();
    return undefined;
  });
  const first = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (_url, options) => fetch(await hangingFixture, options),
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

test("remote subscription downloads are bounded", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const fixture = await startSubscriptionFixture(t, () => ({
    body: "x".repeat(1024 * 1024 + 1),
    status: 200,
  }));
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (_url, options) => fetch(fixture, options),
    host: "127.0.0.1",
    port: 0,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/oversized" },
    method: "POST",
  });

  const failed = await waitForTerminalOperation(daemon.address, created.body.operationId as string);
  assert.equal(failed.body.failure?.stage, "fetching");
  assert.equal(failed.body.failure?.reason, "remote subscription exceeds 1 MiB");
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

async function startSubscriptionFixture(
  t: TestContext,
  responseForRequest: (response: ServerResponse) => { body: string; status: number } | undefined,
): Promise<string> {
  const server = createServer((_request, response) => {
    const fixtureResponse = responseForRequest(response);
    if (!fixtureResponse) {
      return;
    }
    response.writeHead(fixtureResponse.status);
    response.end(fixtureResponse.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("subscription fixture did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
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
