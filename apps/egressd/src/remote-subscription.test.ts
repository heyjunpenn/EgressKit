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
  revisionId?: number;
  status?: string;
  subscriptionId?: string;
}

interface RevisionBody extends OperationBody {
  forced?: boolean;
  nodeCount?: number;
  suspiciousReason?: string;
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
    if (requestNumber <= 3) {
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
    remoteOperationClock: {
      now: () => 0,
      sleep: async () => undefined,
    },
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
  assert.equal(requestNumber, 4);
});

test("temporary subscription failures retry with bounded exponential backoff", async (t) => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    await t.test(String(status), async (subtest) => {
      const stateDirectory = await temporaryStateDirectory(subtest);
      const delays: number[] = [];
      let requests = 0;
      const fixture = await startSubscriptionFixture(subtest, () => {
        requests += 1;
        return requests < 3
          ? { body: "temporarily unavailable", status }
          : { body: VALID_SUBSCRIPTION, status: 200 };
      });
      const daemon = await startEgressd({
        adminToken: "admin-token",
        checkMihomoListener: async () => undefined,
        fetchSubscription: async (_url, options) => fetch(fixture, options),
        host: "127.0.0.1",
        mihomoRuntime: successfulRuntime([]),
        port: 0,
        remoteOperationClock: {
          now: () => 0,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
        },
        stateDirectory,
      });
      subtest.after(() => daemon.close());

      const created = await adminJson(daemon.address, "/subscriptions/remote", {
        body: { url: `https://provider.example/retry-${status}` },
        method: "POST",
      });
      const operation = await waitForTerminalOperation(
        daemon.address,
        created.body.operationId as string,
      );

      assert.equal(operation.body.status, "succeeded");
      assert.equal(requests, 3);
      assert.deepEqual(delays, [1_000, 2_000]);
    });
  }
});

test("retrying hanging error responses releases every response body", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let cancelledBodies = 0;
  let requests = 0;
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async () => {
      requests += 1;
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancelledBodies += 1;
          },
        }),
        { status: 503 },
      );
    },
    host: "127.0.0.1",
    port: 0,
    remoteOperationClock: {
      now: () => 0,
      sleep: async () => undefined,
    },
    stateDirectory,
  });
  t.after(() => daemon.close());

  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/hanging-503" },
    method: "POST",
  });
  const operation = await waitForTerminalOperation(
    daemon.address,
    created.body.operationId as string,
  );
  await daemon.close();

  assert.equal(operation.body.status, "failed");
  assert.equal(requests, 3);
  assert.equal(cancelledBodies, 3);
});

test("network failures retry only up to the operation attempt limit", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const delays: number[] = [];
  let requests = 0;
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async () => {
      requests += 1;
      throw new TypeError("getaddrinfo ENOTFOUND secret.provider.example");
    },
    host: "127.0.0.1",
    port: 0,
    remoteOperationClock: {
      now: () => 0,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
    stateDirectory,
  });
  t.after(() => daemon.close());

  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/dns-failure?token=secret" },
    method: "POST",
  });
  const operation = await waitForTerminalOperation(
    daemon.address,
    created.body.operationId as string,
  );

  assert.equal(operation.body.status, "failed");
  assert.equal(operation.body.failure?.stage, "fetching");
  assert.equal(operation.body.failure?.reason, "remote subscription request failed");
  assert.equal(requests, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.doesNotMatch(JSON.stringify(operation.body), /secret\.provider|token=secret/);
});

test("a bounded Retry-After overrides local backoff for 429", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const delays: number[] = [];
  let requests = 0;
  const fixture = await startSubscriptionFixture(t, (response) => {
    requests += 1;
    if (requests === 1) {
      response.setHeader("retry-after", "7");
      return { body: "rate limited", status: 429 };
    }
    if (requests === 2) {
      response.setHeader("retry-after", "120");
      return { body: "rate limited", status: 429 };
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
    remoteOperationClock: {
      now: () => 0,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
    stateDirectory,
  });
  t.after(() => daemon.close());

  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/rate-limited" },
    method: "POST",
  });
  const operation = await waitForTerminalOperation(
    daemon.address,
    created.body.operationId as string,
  );

  assert.equal(operation.body.status, "succeeded");
  assert.equal(requests, 3);
  assert.deepEqual(delays, [7_000, 2_000]);
});

test("invalid and non-HTTPS subscription URLs are rejected without fetching", async (t) => {
  let fetches = 0;
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async () => {
      fetches += 1;
      return new Response(VALID_SUBSCRIPTION);
    },
    host: "127.0.0.1",
    port: 0,
    stateDirectory: await temporaryStateDirectory(t),
  });
  t.after(() => daemon.close());

  for (const url of ["not a URL", "http://provider.example/subscription"]) {
    const response = await adminJson(daemon.address, "/subscriptions/remote", {
      body: { url },
      method: "POST",
    });
    assert.equal(response.status, 422);
  }
  assert.equal(fetches, 0);
});

test("authentication, format, and schema failures wait for manual refresh", async (t) => {
  const cases = [
    { expectedStage: "fetching", source: "unauthorized", status: 401 },
    { expectedStage: "fetching", source: "forbidden", status: 403 },
    { expectedStage: "fetching", source: "not implemented", status: 501 },
    { expectedStage: "parsing", source: "proxies: [", status: 200 },
    {
      expectedStage: "validating",
      source: "proxies: [{ name: invalid, type: vless }]",
      status: 200,
    },
  ];

  for (const scenario of cases) {
    await t.test(`${scenario.status}-${scenario.expectedStage}`, async (subtest) => {
      const stateDirectory = await temporaryStateDirectory(subtest);
      let requests = 0;
      const delays: number[] = [];
      const fixture = await startSubscriptionFixture(subtest, () => {
        requests += 1;
        return { body: scenario.source, status: scenario.status };
      });
      const daemon = await startEgressd({
        adminToken: "admin-token",
        fetchSubscription: async (_url, options) => fetch(fixture, options),
        host: "127.0.0.1",
        mihomoRuntime: successfulRuntime([]),
        port: 0,
        remoteOperationClock: {
          now: () => 0,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
        },
        stateDirectory,
      });
      subtest.after(() => daemon.close());

      const created = await adminJson(daemon.address, "/subscriptions/remote", {
        body: { url: `https://provider.example/permanent-${scenario.expectedStage}` },
        method: "POST",
      });
      const operation = await waitForTerminalOperation(
        daemon.address,
        created.body.operationId as string,
      );

      assert.equal(operation.body.status, "failed");
      assert.equal(operation.body.failure?.stage, scenario.expectedStage);
      assert.equal(requests, 1);
      assert.deepEqual(delays, []);
    });
  }
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
    remoteOperationClock: {
      now: () => 0,
      sleep: async () => undefined,
    },
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

test("revision layers remain distinct and a suspicious zero-node candidate requires force", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const applied: unknown[] = [];
  const fixture = await startSubscriptionFixture(t, () => ({
    body: "proxies: []\n",
    status: 200,
  }));
  const daemon = await startEgressd({
    adminToken: "admin-token",
    checkMihomoListener: async () => undefined,
    fetchSubscription: async (_url, options) => fetch(fixture, options),
    host: "127.0.0.1",
    mihomoRuntime: runtimeForAllNodes(applied),
    port: 0,
    stateDirectory,
  });
  t.after(() => daemon.close());

  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/empty" },
    method: "POST",
  });
  const evaluated = await waitForTerminalOperation(
    daemon.address,
    created.body.operationId as string,
  );
  const revision = await adminJson(
    daemon.address,
    `/revisions/${evaluated.body.revisionId as number}`,
  );

  assert.equal(evaluated.body.status, "succeeded");
  assert.equal(revision.body.status, "suspicious");
  assert.equal((revision.body as RevisionBody).nodeCount, 0);
  assert.match((revision.body as RevisionBody).suspiciousReason ?? "", /zero nodes/);
  assert.deepEqual(revision.body.history, [
    "saved",
    "downloaded",
    "parsed",
    "validated",
    "suspicious",
  ]);
  assert.equal(applied.length, 0);

  const unauthorizedForce = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/revisions/${evaluated.body.revisionId as number}/force`,
    { method: "POST" },
  );
  assert.equal(unauthorizedForce.status, 401);
  assert.equal(applied.length, 0);

  const forceAttempts = await Promise.all([
    adminJson(daemon.address, `/revisions/${evaluated.body.revisionId as number}/force`, {
      method: "POST",
    }),
    adminJson(daemon.address, `/revisions/${evaluated.body.revisionId as number}/force`, {
      method: "POST",
    }),
  ]);
  assert.deepEqual(forceAttempts.map((attempt) => attempt.status).sort(), [202, 409]);
  const forced = forceAttempts.find(
    (attempt) => attempt.status === 202,
  ) as (typeof forceAttempts)[0];
  const forcedOperation = await waitForTerminalOperation(
    daemon.address,
    forced.body.operationId as string,
  );
  const appliedRevision = await adminJson(
    daemon.address,
    `/revisions/${evaluated.body.revisionId as number}`,
  );

  assert.equal(forcedOperation.body.status, "succeeded");
  assert.equal(forcedOperation.body.revisionId, evaluated.body.revisionId);
  assert.equal((appliedRevision.body as RevisionBody).forced, true);
  assert.equal(appliedRevision.body.status, "ready");
  assert.deepEqual(appliedRevision.body.history, [
    "saved",
    "downloaded",
    "parsed",
    "validated",
    "suspicious",
    "accepted",
    "ready",
  ]);
  assert.equal(appliedRevision.body.history?.includes("healthy"), false);
  assert.equal(applied.length, 1);
});

test("minimum node count and abnormal shrinkage preserve the active revision", async (t) => {
  await t.test("below configured minimum", async (subtest) => {
    const applied: unknown[] = [];
    const fixture = await startSubscriptionFixture(subtest, () => ({
      body: subscriptionWithNodes(2),
      status: 200,
    }));
    const daemon = await startEgressd({
      adminToken: "admin-token",
      fetchSubscription: async (_url, options) => fetch(fixture, options),
      host: "127.0.0.1",
      mihomoRuntime: runtimeForAllNodes(applied),
      minimumSubscriptionNodes: 3,
      port: 0,
      stateDirectory: await temporaryStateDirectory(subtest),
    });
    subtest.after(() => daemon.close());

    const created = await adminJson(daemon.address, "/subscriptions/remote", {
      body: { url: "https://provider.example/below-minimum" },
      method: "POST",
    });
    const operation = await waitForTerminalOperation(
      daemon.address,
      created.body.operationId as string,
    );
    const revision = await adminJson(
      daemon.address,
      `/revisions/${operation.body.revisionId as number}`,
    );

    assert.equal(revision.body.status, "suspicious");
    assert.match((revision.body as RevisionBody).suspiciousReason ?? "", /minimum of 3/);
    assert.equal(applied.length, 0);
  });

  await t.test("more than fifty percent shrinkage", async (subtest) => {
    const stateDirectory = await temporaryStateDirectory(subtest);
    const applied: unknown[] = [];
    let request = 0;
    const fixture = await startSubscriptionFixture(subtest, () => {
      request += 1;
      return { body: subscriptionWithNodes(request === 1 ? 4 : 1), status: 200 };
    });
    const daemon = await startEgressd({
      adminToken: "admin-token",
      checkMihomoListener: async () => undefined,
      fetchSubscription: async (_url, options) => fetch(fixture, options),
      host: "127.0.0.1",
      mihomoRuntime: runtimeForAllNodes(applied),
      port: 0,
      stateDirectory,
    });
    const created = await adminJson(daemon.address, "/subscriptions/remote", {
      body: { url: "https://provider.example/shrinking" },
      method: "POST",
    });
    await waitForTerminalOperation(daemon.address, created.body.operationId as string);
    const refreshed = await adminJson(
      daemon.address,
      `/subscriptions/${created.body.subscriptionId as string}/refresh`,
      { method: "POST" },
    );
    const operation = await waitForTerminalOperation(
      daemon.address,
      refreshed.body.operationId as string,
    );
    const revision = await adminJson(
      daemon.address,
      `/revisions/${operation.body.revisionId as number}`,
    );

    assert.equal(revision.body.status, "suspicious");
    assert.match((revision.body as RevisionBody).suspiciousReason ?? "", /more than 50%/);
    assert.equal(applied.length, 1);
    await daemon.close();
    const state = await openControlState(stateDirectory);
    assert.equal(state.loadActiveRevision()?.imported.nodes.length, 4);
    await state.close();
  });

  await t.test("exactly fifty percent is accepted", async (subtest) => {
    const applied: unknown[] = [];
    let request = 0;
    const fixture = await startSubscriptionFixture(subtest, () => {
      request += 1;
      return { body: subscriptionWithNodes(request === 1 ? 4 : 2), status: 200 };
    });
    const daemon = await startEgressd({
      adminToken: "admin-token",
      checkMihomoListener: async () => undefined,
      fetchSubscription: async (_url, options) => fetch(fixture, options),
      host: "127.0.0.1",
      mihomoRuntime: runtimeForAllNodes(applied),
      port: 0,
      stateDirectory: await temporaryStateDirectory(subtest),
    });
    subtest.after(() => daemon.close());
    const created = await adminJson(daemon.address, "/subscriptions/remote", {
      body: { url: "https://provider.example/fifty-percent" },
      method: "POST",
    });
    await waitForTerminalOperation(daemon.address, created.body.operationId as string);
    const refreshed = await adminJson(
      daemon.address,
      `/subscriptions/${created.body.subscriptionId as string}/refresh`,
      { method: "POST" },
    );
    const operation = await waitForTerminalOperation(
      daemon.address,
      refreshed.body.operationId as string,
    );
    const revision = await adminJson(
      daemon.address,
      `/revisions/${operation.body.revisionId as number}`,
    );

    assert.equal(revision.body.status, "ready");
    assert.equal(applied.length, 2);
  });
});

test("a failed force operation releases its claim for an explicit retry", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let applies = 0;
  const fixture = await startSubscriptionFixture(t, () => ({ body: "proxies: []\n", status: 200 }));
  const daemon = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (_url, options) => fetch(fixture, options),
    host: "127.0.0.1",
    mihomoRuntime: {
      apply: async () => {
        applies += 1;
        if (applies === 1) {
          throw new Error("temporary runtime failure");
        }
        return new Map();
      },
    },
    port: 0,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const created = await adminJson(daemon.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/retry-force" },
    method: "POST",
  });
  const evaluated = await waitForTerminalOperation(
    daemon.address,
    created.body.operationId as string,
  );

  const firstForce = await adminJson(
    daemon.address,
    `/revisions/${evaluated.body.revisionId as number}/force`,
    { method: "POST" },
  );
  const failed = await waitForTerminalOperation(
    daemon.address,
    firstForce.body.operationId as string,
  );
  assert.equal(failed.body.status, "failed");

  const secondForce = await adminJson(
    daemon.address,
    `/revisions/${evaluated.body.revisionId as number}/force`,
    { method: "POST" },
  );
  assert.equal(secondForce.status, 202);
  const succeeded = await waitForTerminalOperation(
    daemon.address,
    secondForce.body.operationId as string,
  );
  const revision = await adminJson(
    daemon.address,
    `/revisions/${evaluated.body.revisionId as number}`,
  );

  assert.equal(succeeded.body.status, "succeeded");
  assert.equal((revision.body as RevisionBody).forced, true);
  assert.equal(applies, 2);
});

test("an interrupted queued force operation releases its claim after restart", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let fetchNumber = 0;
  let markBlockingFetchStarted: (() => void) | undefined;
  const blockingFetchStarted = new Promise<void>((resolve) => {
    markBlockingFetchStarted = resolve;
  });
  const first = await startEgressd({
    adminToken: "admin-token",
    fetchSubscription: async (_url, options) => {
      fetchNumber += 1;
      if (fetchNumber === 1) {
        return new Response("proxies: []\n");
      }
      markBlockingFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    },
    host: "127.0.0.1",
    mihomoRuntime: { apply: async () => new Map() },
    port: 0,
    stateDirectory,
  });
  const created = await adminJson(first.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/interrupted-force" },
    method: "POST",
  });
  const evaluated = await waitForTerminalOperation(
    first.address,
    created.body.operationId as string,
  );
  await adminJson(first.address, "/subscriptions/remote", {
    body: { url: "https://provider.example/blocking" },
    method: "POST",
  });
  await blockingFetchStarted;
  const queuedForce = await adminJson(
    first.address,
    `/revisions/${evaluated.body.revisionId as number}/force`,
    { method: "POST" },
  );
  await first.close();

  const restarted = await startEgressd({
    adminToken: "admin-token",
    host: "127.0.0.1",
    mihomoRuntime: { apply: async () => new Map() },
    port: 0,
    stateDirectory,
  });
  t.after(() => restarted.close());
  const interrupted = await adminJson(
    restarted.address,
    `/operations/${queuedForce.body.operationId as string}`,
  );
  assert.equal(interrupted.body.status, "interrupted");

  const retried = await adminJson(
    restarted.address,
    `/revisions/${evaluated.body.revisionId as number}/force`,
    { method: "POST" },
  );
  assert.equal(retried.status, 202);
  const succeeded = await waitForTerminalOperation(
    restarted.address,
    retried.body.operationId as string,
  );
  assert.equal(succeeded.body.status, "succeeded");
});

function successfulRuntime(applied: unknown[]): MihomoRuntime {
  return {
    apply: async (config) => {
      applied.push(config);
      return new Map([["remote", new URL("http://127.0.0.1:20000")]]);
    },
  };
}

function runtimeForAllNodes(applied: unknown[]): MihomoRuntime {
  return {
    apply: async (config) => {
      applied.push(config);
      return new Map(
        config.listeners.map((listener) => [
          listener.proxy,
          new URL(`http://${listener.listen}:${listener.port}`),
        ]),
      );
    },
  };
}

function subscriptionWithNodes(count: number): string {
  return `proxies:\n${Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(12, "0");
    return `  - { name: remote-${index + 1}, type: vless, server: proxy-${index + 1}.example.com, port: 443, uuid: 11111111-1111-4111-8111-${suffix} }`;
  }).join("\n")}\n`;
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
