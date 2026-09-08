import assert from "node:assert/strict";
import { test } from "node:test";

import { TargetReputation } from "./target-reputation.js";

test("target reputation is scoped, temporary, and never exposes the target", () => {
  let now = 1_000;
  const reputation = new TargetReputation({ now: () => now });

  const result = reputation.record({
    nodeId: "local:first",
    outcome: 429,
    target: "https://Sensitive.Target.Example/path?q=secret",
    ttlMs: 500,
  });

  assert.deepEqual(result, { expiresAt: 1_500, nodeId: "local:first", status: "recorded" });
  assert.deepEqual(
    [...reputation.excludedNodeIds("sensitive.target.example:443")],
    ["local:first"],
  );
  assert.equal(reputation.excludedNodeIds("other.example").size, 0);
  assert.doesNotMatch(JSON.stringify(reputation), /sensitive|target\.example|path|secret/i);

  now = 1_500;
  assert.equal(reputation.excludedNodeIds("https://sensitive.target.example/again").size, 0);
});

test("target reputation accepts only bounded actionable feedback", () => {
  const reputation = new TargetReputation({ now: () => 0 });

  assert.throws(
    () => reputation.record({ nodeId: "node", outcome: 200, target: "example.com" }),
    /outcome must be 403, 429, or risk/,
  );
  assert.throws(
    () => reputation.record({ nodeId: "node", outcome: "risk", target: "example.com", ttlMs: 0 }),
    /ttlMs must be between/,
  );
});

test("expired one-time targets are globally reclaimed within a hard capacity", () => {
  let now = 0;
  const reputation = new TargetReputation({ maximumEntries: 2, now: () => now });
  reputation.record({ nodeId: "one", outcome: 403, target: "one.example", ttlMs: 1 });
  reputation.record({ nodeId: "two", outcome: 403, target: "two.example", ttlMs: 1 });

  now = 2;
  reputation.record({ nodeId: "three", outcome: 429, target: "three.example" });
  reputation.record({ nodeId: "four", outcome: "risk", target: "four.example" });

  assert.deepEqual([...reputation.excludedNodeIds("three.example")], ["three"]);
  assert.deepEqual([...reputation.excludedNodeIds("four.example")], ["four"]);
  reputation.record({ nodeId: "five", outcome: 403, target: "five.example" });
  assert.equal(
    reputation.excludedNodeIds("three.example").size +
      reputation.excludedNodeIds("four.example").size,
    1,
  );
});

test("a recorded response always retains the newly accepted feedback at capacity", () => {
  const reputation = new TargetReputation({ maximumEntries: 1, now: () => 0 });
  reputation.record({ nodeId: "old", outcome: 403, target: "old.example", ttlMs: 60_000 });

  const recorded = reputation.record({
    nodeId: "new",
    outcome: 429,
    target: "new.example",
    ttlMs: 1,
  });

  assert.equal(recorded.status, "recorded");
  assert.equal(reputation.excludedNodeIds("old.example").size, 0);
  assert.deepEqual([...reputation.excludedNodeIds("new.example")], ["new"]);
});
