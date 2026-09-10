import assert from "node:assert/strict";
import { test } from "node:test";

import { RotateScheduler, type SchedulerCandidate } from "./scheduler.js";

function candidate(id: string, overrides: Partial<SchedulerCandidate> = {}): SchedulerCandidate {
  return {
    activeConnections: 0,
    consecutiveFailures: 0,
    ewmaLatencyMs: 20,
    generation: id,
    healthy: true,
    id,
    listener: new URL(`http://127.0.0.1:${id === "fast" ? 20_001 : 20_002}`),
    manualWeight: 1,
    successRate: 1,
    ...overrides,
  };
}

test("rotate selects the available proxy that has been unused for the longest", () => {
  const scheduler = new RotateScheduler([
    candidate("fast", { ewmaLatencyMs: 10 }),
    candidate("slower", { ewmaLatencyMs: 20 }),
    candidate("third", { ewmaLatencyMs: 30 }),
  ]);

  const selections = Array.from({ length: 6 }, () => {
    const lease = scheduler.acquire();
    assert.ok(lease);
    lease.release();
    return lease.candidate.id;
  });

  assert.deepEqual(selections, ["fast", "slower", "third", "fast", "slower", "third"]);
});

test("verified-only rotate schedules egress IP groups instead of duplicate node slots", () => {
  const scheduler = new RotateScheduler(
    [
      candidate("a1", { exitIp: "203.0.113.1" }),
      candidate("a2", { exitIp: "203.0.113.1" }),
      candidate("b1", { exitIp: "198.51.100.8" }),
      candidate("pending"),
    ],
    { requireExitIdentity: true },
  );

  const selections = Array.from({ length: 4 }, () => {
    const lease = scheduler.acquire();
    assert.ok(lease);
    lease.release();
    return lease.candidate.exitIp;
  });

  assert.deepEqual(selections, ["203.0.113.1", "198.51.100.8", "203.0.113.1", "198.51.100.8"]);
  assert.equal(scheduler.acquireBySelector("pending"), undefined);
});

test("specified node resolves to its egress IP group", () => {
  const scheduler = new RotateScheduler(
    [
      candidate("a1", { exitIp: "203.0.113.1", healthy: false, selectors: ["primary"] }),
      candidate("a2", { exitIp: "203.0.113.1" }),
      candidate("b1", { exitIp: "198.51.100.8" }),
    ],
    { requireExitIdentity: true },
  );

  const lease = scheduler.acquireBySelector("primary");
  assert.equal(lease?.candidate.id, "a2");
  lease?.release();
});

test("rotate excludes proxies that are unavailable", () => {
  const scheduler = new RotateScheduler([
    candidate("fast", { activeConnections: 100, manualWeight: 2 }),
    candidate("slower", {
      consecutiveFailures: 1,
      ewmaLatencyMs: 40,
      manualWeight: 4,
      successRate: 0.8,
    }),
    candidate("unhealthy", { healthy: false, manualWeight: 100 }),
  ]);

  const selections = Array.from({ length: 4 }, () => {
    const lease = scheduler.acquire();
    assert.ok(lease);
    lease.release();
    return lease.candidate.id;
  });

  assert.deepEqual(selections, ["fast", "slower", "fast", "slower"]);
  assert.ok(!selections.includes("unhealthy"));
});

test("explicit and sticky use also update which proxy was used most recently", () => {
  const scheduler = new RotateScheduler([candidate("first"), candidate("second")]);
  scheduler.acquireById("first")?.release();
  const rotate = scheduler.acquire();
  assert.equal(rotate?.candidate.id, "second");
  rotate?.release();
});

test("manual enabled state excludes and restores a candidate", () => {
  const scheduler = new RotateScheduler([candidate("first")]);

  assert.equal(scheduler.setManualEnabled("first", false), true);
  assert.equal(scheduler.acquire(), undefined);
  assert.equal(scheduler.snapshot()[0]?.manualWeight, 0);

  assert.equal(scheduler.setManualEnabled("first", true), true);
  const lease = scheduler.acquire();
  assert.equal(lease?.candidate.id, "first");
  lease?.release();
});

test("explicit selectors are unique, exact, and never fall back", () => {
  const scheduler = new RotateScheduler([
    candidate("first", { selectors: ["primary"] }),
    candidate("second", { selectors: ["backup"] }),
  ]);

  const selected = scheduler.acquireBySelector("backup");
  assert.equal(selected?.candidate.id, "second");
  selected?.release();
  assert.equal(scheduler.acquireBySelector("missing"), undefined);

  const unavailable = new RotateScheduler([
    candidate("healthy", { selectors: ["available"] }),
    candidate("failed", { healthy: false, selectors: ["unavailable"] }),
  ]);
  assert.equal(unavailable.acquireBySelector("unavailable"), undefined);

  assert.throws(
    () =>
      new RotateScheduler([
        candidate("one", { selectors: ["duplicate"] }),
        candidate("two", { selectors: ["duplicate"] }),
      ]),
    /duplicate scheduler selector/,
  );
});

test("pre-connect retries exclude attempted nodes and record connection outcomes", () => {
  const scheduler = new RotateScheduler([candidate("first"), candidate("second")]);

  const first = scheduler.acquire();
  assert.equal(first?.candidate.id, "first");
  first?.reportConnectionFailure();
  first?.release();

  const fallback = scheduler.acquire(new Set(["first"]));
  assert.equal(fallback?.candidate.id, "second");
  fallback?.reportConnectionSuccess(12);
  fallback?.release();

  assert.equal(scheduler.acquire(new Set(["first", "second"])), undefined);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.find(({ id }) => id === "first")?.consecutiveFailures, 1);
  assert.equal(snapshot.find(({ id }) => id === "second")?.consecutiveFailures, 0);
});

test("runtime health gates selection and survives candidate replacement", () => {
  const scheduler = new RotateScheduler([candidate("first"), candidate("second")]);

  assert.equal(scheduler.setHealthStatus("first", "warming"), true);
  assert.equal(scheduler.acquireById("first"), undefined);
  assert.equal(scheduler.setHealthStatus("first", "degraded"), true);
  const degraded = scheduler.acquireById("first");
  assert.equal(degraded?.candidate.id, "first");
  degraded?.reportConnectionFailure();
  degraded?.release();

  scheduler.replaceCandidates([candidate("first"), candidate("second")]);

  assert.equal(scheduler.healthStatus("first"), "degraded");
  assert.equal(scheduler.snapshot().find(({ id }) => id === "first")?.consecutiveFailures, 1);
  assert.equal(scheduler.setHealthStatus("first", "disabled"), true);
  assert.equal(scheduler.acquireBySelector("first"), undefined);
});

test("active probe outcomes update scheduler reliability signals", () => {
  const scheduler = new RotateScheduler([candidate("node")]);

  assert.equal(scheduler.reportHealthCheck("node", false), true);
  assert.equal(scheduler.snapshot()[0]?.consecutiveFailures, 1);
  assert.equal(scheduler.snapshot()[0]?.successRate, 0.8);
  assert.equal(scheduler.reportHealthCheck("node", true), true);
  assert.equal(scheduler.snapshot()[0]?.consecutiveFailures, 0);
  assert.ok(Math.abs((scheduler.snapshot()[0]?.successRate ?? 0) - 0.84) < 0.000_001);
});

test("replaced generations stop new traffic and drain existing leases before removal", () => {
  const removed: string[] = [];
  const scheduler = new RotateScheduler([candidate("node", { generation: "old" })]);
  const oldLease = scheduler.acquireById("node");
  assert.equal(oldLease?.candidate.generation, "old");

  scheduler.replaceCandidates([candidate("node", { generation: "old" })]);

  scheduler.replaceCandidates([candidate("node", { generation: "new" })], (drained) =>
    removed.push(drained.generation),
  );

  assert.deepEqual(removed, []);
  const newLease = scheduler.acquireById("node");
  assert.equal(newLease?.candidate.generation, "new");
  newLease?.release();
  assert.deepEqual(removed, []);
  oldLease?.release();
  assert.deepEqual(removed, ["old"]);
});

test("candidate validation is atomic before an active generation starts draining", () => {
  const removed: string[] = [];
  const scheduler = new RotateScheduler([candidate("old")]);

  assert.throws(
    () =>
      scheduler.replaceCandidates([candidate("invalid", { manualWeight: -1 })], (drained) =>
        removed.push(drained.id),
      ),
    /manualWeight must be a non-negative finite number/,
  );

  assert.deepEqual(removed, []);
  const lease = scheduler.acquireById("old");
  assert.equal(lease?.candidate.id, "old");
  lease?.release();
});
