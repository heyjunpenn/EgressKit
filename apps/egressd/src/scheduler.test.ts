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

test("each scheduling signal can independently change the next selection", () => {
  for (const penalty of [
    { manualWeight: 0.5 },
    { ewmaLatencyMs: 40 },
    { successRate: 0.5 },
    { consecutiveFailures: 1 },
    { activeConnections: 1 },
  ]) {
    const scheduler = new RotateScheduler([candidate("penalized", penalty), candidate("baseline")]);

    const lease = scheduler.acquire();
    assert.ok(lease);
    assert.equal(lease.candidate.id, "baseline");
    lease.release();
  }
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
