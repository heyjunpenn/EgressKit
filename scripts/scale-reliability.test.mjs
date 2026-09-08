import assert from "node:assert/strict";
import test from "node:test";

import {
  closeAll,
  closeInOrder,
  countOpenTunnels,
  percentile,
  runBenchmark,
  soakReliabilityVerdict,
  verdict,
} from "./scale-reliability.mjs";

test("percentile uses the nearest-rank observation without inventing samples", () => {
  assert.equal(percentile([9, 1, 5, 3], 0.95), 9);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
});

test("benchmark verdicts distinguish measured capability from unmet targets", () => {
  assert.deepEqual(verdict(100, 100), { measured: 100, passed: true, target: 100 });
  assert.deepEqual(verdict(99, 100), { measured: 99, passed: false, target: 100 });
});

test("concurrent CONNECT count excludes tunnels closed before the barrier", () => {
  assert.equal(
    countOpenTunnels([
      { socket: { destroyed: false, readable: true, writable: true } },
      { socket: { destroyed: true, readable: false, writable: false } },
      { socket: { destroyed: false, readable: false, writable: true } },
    ]),
    1,
  );
});

test("soak reliability requires every concurrency seam to be observed", () => {
  const complete = {
    connectAttempts: 1,
    connectFailures: 0,
    drainingCycles: 3,
    mihomoRestarts: 3,
    sqliteWalReads: 1,
    subscriptionUpdates: 3,
  };
  assert.equal(soakReliabilityVerdict(complete, 60, 60, "wal").passed, true);
  for (const override of [
    { drainingCycles: 2 },
    { mihomoRestarts: 2 },
    { sqliteWalReads: 0 },
    { subscriptionUpdates: 2 },
  ]) {
    assert.equal(soakReliabilityVerdict({ ...complete, ...override }, 60, 60, "wal").passed, false);
  }
  assert.equal(soakReliabilityVerdict(complete, 60, 60, "delete").passed, false);
});

test("cleanup attempts every resource and reports all failures", async () => {
  const attempted = [];
  await assert.rejects(
    closeAll([
      () => {
        attempted.push("first");
        throw new Error("first failed");
      },
      async () => {
        attempted.push("second");
        throw new Error("second failed");
      },
    ]),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(attempted, ["first", "second"]);
});

test("cleanup phases wait for owners before removing their directory", async () => {
  const events = [];
  let releaseOwner;
  const ownerClosed = new Promise((resolve) => {
    releaseOwner = resolve;
  });
  const cleanup = closeInOrder([
    [
      async () => {
        events.push("owner-start");
        await ownerClosed;
        events.push("owner-end");
        throw new Error("owner failed");
      },
    ],
    [
      async () => {
        events.push("directory");
        throw new Error("directory failed");
      },
    ],
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["owner-start"]);
  releaseOwner();
  await assert.rejects(
    cleanup,
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(events, ["owner-start", "owner-end", "directory"]);
});

test("soak duration rejects zero, negative, non-numeric, and short runs", async () => {
  for (const soakSeconds of [0, -1, Number.NaN, 59]) {
    await assert.rejects(runBenchmark({ soakSeconds }), /at least 60 seconds/);
  }
});

test("checked-in report preserves raw failures and does not claim soak reliability", async () => {
  const report = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../docs/benchmarks/2026-09-08-m3-pro-darwin-arm64.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(report.measurements.subscriptionNodes.target, 500);
  assert.equal(report.measurements.activeListeners.target, 100);
  assert.equal(report.measurements.concurrentConnects.target, 1_000);
  assert.equal(report.measurements.activeSessions.target, 10_000);
  assert.equal(report.measurements.soakReliability.passed, false);
  assert.ok(report.raw.soak.connectFailures > 0);
});
