import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("./release.yml", import.meta.url);

test("the release workflow builds both commands on every supported host architecture", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const runner of ["ubuntu-latest", "ubuntu-24.04-arm", "macos-15-intel", "macos-15"]) {
    assert.match(workflow, new RegExp(`runner: ${runner}`));
  }
  assert.match(workflow, /pnpm --filter @egresskit\/egressd build/);
  assert.match(workflow, /dist\/control-cli-bin\.js/);
  assert.match(workflow, /dist\/cli\.js/);
  assert.match(workflow, /docker\/build-push-action/);
  assert.match(workflow, /linux\/amd64,linux\/arm64/);
});
