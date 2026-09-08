import assert from "node:assert/strict";
import { test } from "node:test";

import { RotateScheduler, type SchedulerCandidate } from "./scheduler.js";

function candidate(id: string, overrides: Partial<SchedulerCandidate> = {}): SchedulerCandidate {
  return {
    activeConnections: 0,
    consecutiveFailures: 0,
    ewmaLatencyMs: 20,
    healthy: true,
    id,
    listener: new URL(`http://127.0.0.1:${id === "fast" ? 20_001 : 20_002}`),
    manualWeight: 1,
    successRate: 1,
    ...overrides,
  };
}

test("rotate selection favors stronger candidates without starving other healthy exits", () => {
  const scheduler = new RotateScheduler([
    candidate("fast", { ewmaLatencyMs: 10 }),
    candidate("slower", { ewmaLatencyMs: 20 }),
  ]);

  const selections = Array.from({ length: 12 }, () => {
    const lease = scheduler.acquire();
    assert.ok(lease);
    lease.release();
    return lease.candidate.id;
  });

  const fastSelections = selections.filter((id) => id === "fast").length;
  const slowerSelections = selections.filter((id) => id === "slower").length;
  assert.ok(fastSelections > slowerSelections);
  assert.ok(slowerSelections > 0);
});

test("rotate selection accounts for health, weight, reliability, failures, and load", () => {
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

  const selections = Array.from({ length: 10 }, () => {
    const lease = scheduler.acquire();
    assert.ok(lease);
    lease.release();
    return lease.candidate.id;
  });

  assert.ok(selections.includes("fast"));
  assert.ok(selections.includes("slower"));
  assert.ok(!selections.includes("unhealthy"));
});
