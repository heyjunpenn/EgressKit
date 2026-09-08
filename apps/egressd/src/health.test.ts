import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { NodeHealthController, probeThroughMihomo } from "./health.js";

test("active probes use the node's internal Mihomo listener", async () => {
  let observedUrl: string | undefined;
  const listener = createServer((request, response) => {
    observedUrl = request.url;
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");

  try {
    const succeeded = await probeThroughMihomo(
      new URL(`http://127.0.0.1:${address.port}`),
      new URL("https://health.example/status?region=eu"),
      1_000,
    );

    assert.equal(succeeded, true);
    assert.equal(observedUrl, "https://health.example/status?region=eu");
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("health checks apply multiple-target threshold, global concurrency, and jitter", async () => {
  let active = 0;
  let maximumActive = 0;
  let releaseProbes: (() => void) | undefined;
  const outcomes: { id: string; succeeded: boolean }[] = [];
  const gate = new Promise<void>((resolve) => {
    releaseProbes = resolve;
  });
  const controller = new NodeHealthController({
    concurrency: 2,
    healthUrls: [
      new URL("https://one.example/health"),
      new URL("https://two.example/health"),
      new URL("https://three.example/health"),
    ],
    intervalMs: 1_000,
    jitterMs: 100,
    onProbeResult: (id, succeeded) => outcomes.push({ id, succeeded }),
    probe: async (_listener, target) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return target.hostname !== "three.example";
    },
    random: sequenceRandom([0, 0.5]),
    successThreshold: 2,
  });
  controller.replaceNodes(
    [
      { id: "one", listener: new URL("http://127.0.0.1:20001") },
      { id: "two", listener: new URL("http://127.0.0.1:20002") },
    ],
    10_000,
  );

  assert.deepEqual(
    controller.snapshot().map(({ id, nextProbeAt, status }) => ({ id, nextProbeAt, status })),
    [
      { id: "one", nextProbeAt: 10_000, status: "warming" },
      { id: "two", nextProbeAt: 10_050, status: "warming" },
    ],
  );

  const checking = controller.runDue(10_050);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 2);
  releaseProbes?.();
  await checking;

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    controller.snapshot().map(({ status }) => status),
    ["healthy", "healthy"],
  );
  assert.deepEqual(outcomes, [
    { id: "one", succeeded: true },
    { id: "two", succeeded: true },
  ]);
});

test("consecutive failures degrade, cool down exponentially, and require a warming probe", async () => {
  let probeSucceeds = true;
  const controller = new NodeHealthController({
    cooldownInitialMs: 60_000,
    cooldownMaximumMs: 90_000,
    degradedAfterFailures: 2,
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => probeSucceeds,
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  await controller.runDue(0);
  probeSucceeds = false;

  controller.recordConnectionFailure("node", 1);
  assert.equal(controller.snapshot()[0]?.status, "healthy");
  controller.recordConnectionFailure("node", 2);
  assert.equal(controller.snapshot()[0]?.status, "degraded");
  controller.recordConnectionFailure("node", 3);
  assert.deepEqual(controller.snapshot()[0], {
    consecutiveFailures: 3,
    cooldownCount: 1,
    id: "node",
    manuallyEnabled: true,
    nextProbeAt: 60_003,
    status: "cooldown",
  });

  await controller.runDue(60_002);
  assert.equal(controller.snapshot()[0]?.status, "cooldown");
  await controller.runDue(60_003);
  assert.equal(controller.snapshot()[0]?.status, "cooldown");
  assert.equal(controller.snapshot()[0]?.nextProbeAt, 150_003);

  probeSucceeds = true;
  const recovery = controller.runDue(150_003);
  assert.equal(controller.snapshot()[0]?.status, "warming");
  await recovery;
  assert.deepEqual(controller.snapshot()[0], {
    consecutiveFailures: 0,
    cooldownCount: 0,
    id: "node",
    manuallyEnabled: true,
    nextProbeAt: 180_003,
    status: "healthy",
  });
});

test("a successful connection breaks a sequence of passive failures without bypassing probes", () => {
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => true,
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);

  controller.recordConnectionFailure("node", 1);
  controller.recordConnectionSuccess("node");
  controller.recordConnectionFailure("node", 2);

  assert.equal(controller.snapshot()[0]?.consecutiveFailures, 1);
  assert.equal(controller.snapshot()[0]?.status, "warming");
});

test("manual disable is never overridden by probes or cooldown expiry", async () => {
  let probeCount = 0;
  const statuses: string[] = [];
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    onStatusChange: (_id, status) => statuses.push(status),
    probe: async () => {
      probeCount += 1;
      return true;
    },
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  assert.equal(controller.setManualEnabled("node", false, 1), true);

  controller.recordConnectionFailure("node", 2);
  await controller.runDue(Number.MAX_SAFE_INTEGER);

  assert.equal(probeCount, 0);
  assert.equal(controller.snapshot()[0]?.status, "disabled");
  assert.equal(statuses.at(-1), "disabled");
});

test("a stale probe cannot approve a replacement listener for the same node", async () => {
  let releaseProbe: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const statuses: string[] = [];
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    onStatusChange: (_id, status) => statuses.push(status),
    probe: async () => {
      await gate;
      return true;
    },
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  const staleProbe = controller.runDue(0);
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20002") }], 1);

  releaseProbe?.();
  await staleProbe;

  assert.equal(controller.snapshot()[0]?.status, "warming");
  assert.equal(controller.snapshot()[0]?.nextProbeAt, 1);
  assert.equal(statuses.at(-1), "warming");
});

function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}
