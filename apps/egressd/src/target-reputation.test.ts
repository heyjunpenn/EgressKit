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
