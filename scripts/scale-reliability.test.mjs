import assert from "node:assert/strict";
import test from "node:test";

import { percentile, verdict } from "./scale-reliability.mjs";

test("percentile uses the nearest-rank observation without inventing samples", () => {
  assert.equal(percentile([9, 1, 5, 3], 0.95), 9);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
});

test("benchmark verdicts distinguish measured capability from unmet targets", () => {
  assert.deepEqual(verdict(100, 100), { measured: 100, passed: true, target: 100 });
  assert.deepEqual(verdict(99, 100), { measured: 99, passed: false, target: 100 });
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
