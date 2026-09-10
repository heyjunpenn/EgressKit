import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { discoverExitIdentity, NodeHealthController, probeThroughMihomo } from "./health.js";

test("exit discovery falls back across providers and normalizes location fields", async () => {
  const attempted: string[] = [];
  const identity = await discoverExitIdentity(
    [
      { host: "one.example", name: "one", path: "/json" },
      { host: "two.example", name: "two", path: "/json" },
      { host: "three.example", name: "three", path: "/json" },
    ],
    async ({ name }) => {
      attempted.push(name);
      if (name === "one") return undefined;
      if (name === "two") return { error: true, ip: "not-an-ip" };
      return { city: "Osaka", country_code: "JP", ip: "198.51.100.8" };
    },
    () => 123,
  );

  assert.deepEqual(attempted, ["one", "two", "three"]);
  assert.deepEqual(identity, {
    city: "Osaka",
    country: "JP",
    ip: "198.51.100.8",
    provider: "three",
    verifiedAt: 123,
  });
});

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

test("aborting a listener-backed probe destroys a hanging request", async () => {
  let observed: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const listener = createServer(() => observed?.());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();

  const probing = probeThroughMihomo(
    new URL(`http://127.0.0.1:${address.port}`),
    new URL("http://health.example/status"),
    10_000,
    controller.signal,
  );
  await received;
  controller.abort();

  assert.equal(await probing, false);
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

test("scheduled checks refresh an existing public exit IP", async () => {
  let exitProbeCalls = 0;
  const controller = new NodeHealthController({
    exitIpProbe: async () => {
      exitProbeCalls += 1;
      return {
        city: "Tokyo",
        country: "JP",
        ip: "203.0.113.24",
        provider: "ipinfo",
        verifiedAt: 10_000,
      };
    },
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    probe: async () => true,
  });
  controller.replaceNodes([{ id: "tokyo", listener: new URL("http://127.0.0.1:20001") }], 10_000);

  await controller.runDue(10_000);

  assert.equal(controller.snapshot()[0]?.exitIp, "203.0.113.24");
  assert.equal(controller.snapshot()[0]?.exitLocation, "JP-Tokyo");
  await controller.runDue(40_000);
  assert.equal(exitProbeCalls, 2);
});

test("exit discovery queues every node with at most five concurrent probes", async () => {
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new NodeHealthController({
    exitIpProbe: async (listener) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return {
        ip: `203.0.113.${Number(listener.port) - 20_000}`,
        provider: "test",
        verifiedAt: 10_000,
      };
    },
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    probe: async () => true,
  });
  controller.replaceNodes(
    Array.from({ length: 12 }, (_, index) => ({
      id: `node-${index + 1}`,
      listener: new URL(`http://127.0.0.1:${20_001 + index}`),
    })),
    10_000,
  );

  const running = controller.verifyAllExits();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 5);
  release?.();
  await running;
  assert.equal(controller.snapshot().filter(({ exitIp }) => exitIp).length, 12);
});

test("manual exit verification shares the five-probe concurrency limit", async () => {
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new NodeHealthController({
    exitIpProbe: async (listener) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return {
        ip: `203.0.113.${Number(listener.port) - 20_000}`,
        provider: "test",
        verifiedAt: 10_000,
      };
    },
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    probe: async () => true,
  });
  controller.replaceNodes(
    Array.from({ length: 12 }, (_, index) => ({
      id: `node-${index + 1}`,
      listener: new URL(`http://127.0.0.1:${20_001 + index}`),
    })),
    10_000,
  );

  const running = Promise.all(
    Array.from({ length: 12 }, (_, index) => controller.verifyExit(`node-${index + 1}`)),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 5);
  release?.();
  await running;
});

test("bulk exit verification checks every enabled node and returns each result", async () => {
  const controller = new NodeHealthController({
    exitIpProbe: async (listener) => ({
      ip: `203.0.113.${Number(listener.port) - 20_000}`,
      provider: "test",
      verifiedAt: 10_000,
    }),
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    probe: async () => true,
  });
  controller.replaceNodes([
    { id: "node-1", listener: new URL("http://127.0.0.1:20001") },
    { id: "node-2", listener: new URL("http://127.0.0.1:20002") },
  ]);

  const results = await controller.verifyAllExits();

  assert.deepEqual(
    results.map(({ id, identity }) => ({ id, ip: identity?.ip })),
    [
      { id: "node-1", ip: "203.0.113.1" },
      { id: "node-2", ip: "203.0.113.2" },
    ],
  );
});

test("node availability is derived only from a verified exit IP", async () => {
  const controller = new NodeHealthController({
    exitIpProbe: async () => ({
      ip: "203.0.113.8",
      provider: "test",
      verifiedAt: 10_000,
    }),
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    probe: async () => true,
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);

  assert.equal(controller.snapshot()[0]?.status, "unavailable");
  await controller.verifyExit("node");
  assert.equal(controller.snapshot()[0]?.status, "available");
});

test("scheduled exit checks process ten nodes per ordered round by default", async () => {
  const checked: string[] = [];
  const controller = new NodeHealthController({
    exitIpProbe: async (listener) => {
      checked.push(listener.port);
      return { ip: `203.0.113.${listener.port}`, provider: "test", verifiedAt: 1 };
    },
    healthUrls: [new URL("https://health.example/status")],
    intervalMs: 30_000,
    jitterMs: 0,
  });
  controller.replaceNodes(
    Array.from({ length: 12 }, (_, index) => ({
      id: `node-${index + 1}`,
      listener: new URL(`http://127.0.0.1:${20_001 + index}`),
    })),
    0,
  );

  await controller.runDue(0);
  assert.deepEqual(
    checked,
    Array.from({ length: 10 }, (_, index) => String(20_001 + index)),
  );
  await controller.runDue(29_999);
  assert.equal(checked.length, 10);
  await controller.runDue(30_000);
  assert.deepEqual(checked.slice(10), [
    "20011",
    "20012",
    "20001",
    "20002",
    "20003",
    "20004",
    "20005",
    "20006",
    "20007",
    "20008",
  ]);
});

test("ten consecutive failed checks revoke an exit IP and a later check restores it", async () => {
  let succeeds = true;
  const revoked: string[] = [];
  const controller = new NodeHealthController({
    exitIpProbe: async () =>
      succeeds ? { ip: "203.0.113.8", provider: "test", verifiedAt: 1 } : undefined,
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    onExitIdentityCleared: (id) => revoked.push(id),
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  await controller.verifyExit("node");
  succeeds = false;

  for (let attempt = 1; attempt < 10; attempt += 1) {
    await controller.verifyExit("node");
    assert.equal(controller.snapshot()[0]?.status, "available");
  }
  await controller.verifyExit("node");
  assert.equal(controller.snapshot()[0]?.status, "unavailable");
  assert.deepEqual(revoked, ["node"]);

  succeeds = true;
  await controller.verifyExit("node");
  assert.equal(controller.snapshot()[0]?.status, "available");
});

test("ten consecutive proxy connection failures revoke an available exit", async () => {
  const revoked: string[] = [];
  const controller = new NodeHealthController({
    exitIpProbe: async () => ({ ip: "203.0.113.8", provider: "test", verifiedAt: 1 }),
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    onExitIdentityCleared: (id) => revoked.push(id),
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  await controller.verifyExit("node");

  for (let attempt = 1; attempt < 10; attempt += 1) {
    controller.recordConnectionFailure("node", attempt);
    assert.equal(controller.snapshot()[0]?.status, "available");
  }
  controller.recordConnectionFailure("node", 10);

  assert.equal(controller.snapshot()[0]?.status, "unavailable");
  assert.deepEqual(revoked, ["node"]);
});

test("manual exit verification discards a result from a replaced generation", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorded: string[] = [];
  const controller = new NodeHealthController({
    exitIpProbe: async () => {
      markStarted?.();
      await gate;
      return { ip: "203.0.113.24", provider: "test", verifiedAt: 10_000 };
    },
    healthUrls: [new URL("https://health.example/status")],
    jitterMs: 0,
    onExitIdentity: (id) => recorded.push(id),
    probe: async () => true,
  });
  controller.replaceNodes(
    [
      {
        generation: "first",
        id: "node",
        listener: new URL("http://127.0.0.1:20001"),
      },
    ],
    10_000,
  );

  const verifying = controller.verifyExit("node");
  await started;
  controller.replaceNodes(
    [
      {
        generation: "second",
        id: "node",
        listener: new URL("http://127.0.0.1:20002"),
      },
    ],
    10_001,
  );
  release?.();

  assert.equal(await verifying, undefined);
  assert.deepEqual(recorded, []);
  assert.equal(controller.snapshot()[0]?.exitIp, undefined);
});

test("exit discovery rejects malformed IPv4 and IPv6 values", async () => {
  for (const invalidIp of ["999.999.999.999", ":"]) {
    const identity = await discoverExitIdentity(
      [{ host: "invalid.example", name: "invalid", path: "/json" }],
      async () => ({ ip: invalidIp }),
    );

    assert.equal(identity, undefined, invalidIp);
  }
});

test.skip("legacy multi-target health state machine", async () => {
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

test.skip("legacy cooldown health state machine", async () => {
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
  controller.setManualEnabled("node", false);
  assert.equal(controller.snapshot()[0]?.status, "disabled");
  controller.setManualEnabled("node", true);
  assert.equal(controller.snapshot()[0]?.status, "cooldown");
  assert.equal(controller.snapshot()[0]?.nextProbeAt, 60_003);

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

test.skip("legacy warming health state machine", async () => {
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => false,
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);

  await controller.runDue(0);
  assert.equal(controller.snapshot()[0]?.status, "warming");
  await controller.runDue(30_000);
  assert.equal(controller.snapshot()[0]?.status, "degraded");
  await controller.runDue(60_000);
  assert.equal(controller.snapshot()[0]?.status, "cooldown");
});

test.skip("legacy passive health state machine", () => {
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

test.skip("legacy manual health state machine", async () => {
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
  assert.equal(controller.setManualEnabled("node", false), true);

  controller.recordConnectionFailure("node", 2);
  await controller.runDue(Number.MAX_SAFE_INTEGER);

  assert.equal(probeCount, 0);
  assert.equal(controller.snapshot()[0]?.status, "disabled");
  assert.equal(statuses.at(-1), "disabled");
});

test.skip("legacy stale active health probe", async () => {
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

test.skip("legacy generation warming", async () => {
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => true,
  });
  const listener = new URL("http://127.0.0.1:20001");
  controller.replaceNodes([{ generation: "first", id: "node", listener }], 0);
  await controller.runDue(0);
  assert.equal(controller.snapshot()[0]?.status, "healthy");

  controller.replaceNodes([{ generation: "second", id: "node", listener }], 5);

  assert.equal(controller.snapshot()[0]?.status, "warming");
  assert.equal(controller.snapshot()[0]?.nextProbeAt, 5);
});

test.skip("legacy cooldown race", async () => {
  let releaseProbe: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => {
      await gate;
      return true;
    },
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  const staleProbe = controller.runDue(0);
  controller.recordConnectionFailure("node", 1);
  controller.recordConnectionFailure("node", 2);
  controller.recordConnectionFailure("node", 3);
  assert.equal(controller.snapshot()[0]?.status, "cooldown");

  releaseProbe?.();
  await staleProbe;

  assert.equal(controller.snapshot()[0]?.status, "cooldown");
  assert.equal(controller.snapshot()[0]?.nextProbeAt, 60_003);
});

test.skip("legacy active probe scheduling", async () => {
  let probeCount = 0;
  let releaseSecondProbe: (() => void) | undefined;
  const secondProbeGate = new Promise<void>((resolve) => {
    releaseSecondProbe = resolve;
  });
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => {
      probeCount += 1;
      if (probeCount === 2) {
        await secondProbeGate;
      }
      return true;
    },
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  await controller.runDue(0);
  const staleProbe = controller.runDue(30_000);
  controller.recordConnectionSuccess("node", 30_001);
  releaseSecondProbe?.();
  await staleProbe;

  assert.equal(controller.snapshot()[0]?.nextProbeAt, 60_001);
  await controller.runDue(60_001);
  assert.equal(probeCount, 3);
});

test.skip("legacy warming enable transition", async () => {
  let releaseProbe: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let probeCount = 0;
  const controller = new NodeHealthController({
    healthUrls: [new URL("https://health.example")],
    jitterMs: 0,
    probe: async () => {
      probeCount += 1;
      if (probeCount === 1) {
        await gate;
      }
      return true;
    },
  });
  controller.replaceNodes([{ id: "node", listener: new URL("http://127.0.0.1:20001") }], 0);
  const staleProbe = controller.runDue(0);
  controller.setManualEnabled("node", false, 1);
  controller.setManualEnabled("node", true, 2);
  releaseProbe?.();
  await staleProbe;

  assert.equal(controller.snapshot()[0]?.status, "warming");
  assert.equal(controller.snapshot()[0]?.nextProbeAt, 30_001);
  await controller.runDue(30_001);
  assert.equal(controller.snapshot()[0]?.status, "healthy");
});

function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}
