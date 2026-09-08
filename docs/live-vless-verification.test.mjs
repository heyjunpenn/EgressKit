import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("authorized VLESS verification is documented and isolated from secretless CI", async () => {
  const [documentation, packageJson, workflow] = await Promise.all([
    readFile(new URL("live-vless-verification.md", import.meta.url), "utf8"),
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
    readFile(new URL(".github/workflows/release.yml", root), "utf8"),
  ]);

  assert.match(documentation, /EGRESSKIT_LIVE_SUBSCRIPTION_URL/);
  assert.match(documentation, /local implementation/i);
  assert.match(documentation, /Mihomo acceptance/i);
  assert.match(documentation, /target reachability/i);
  assert.match(documentation, /real exit verification/i);
  assert.match(documentation, /never (?:print|record).*subscription/i);
  assert.equal(packageJson.scripts["test:live:vless"], "node scripts/live-vless.mjs");
  assert.doesNotMatch(packageJson.scripts.verify, /test:live:vless/);
  assert.doesNotMatch(workflow, /EGRESSKIT_LIVE_SUBSCRIPTION_URL|test:live:vless/);
});

test("the checked-in evidence is reproducible metadata without node secrets", async () => {
  const documentation = await readFile(
    new URL("live-vless-verification.md", import.meta.url),
    "utf8",
  );

  assert.match(documentation, /2026-09-08/);
  assert.match(documentation, /Mihomo Meta v1\.19\.30/);
  assert.match(documentation, /Darwin 25\.6\.0 arm64/);
  assert.match(documentation, /170 VLESS nodes/);
  assert.doesNotMatch(documentation, /\/sub\/[a-z0-9]+/i);
  assert.doesNotMatch(documentation, /uuid\s*[:=]/i);
});
