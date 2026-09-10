import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("./release.yml", import.meta.url);

test("the release workflow builds both commands on every supported host architecture", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /pull_request:/);
  for (const runner of ["ubuntu-latest", "ubuntu-24.04-arm", "macos-15-intel", "macos-15"]) {
    assert.match(workflow, new RegExp(`runner: ${runner}`));
  }
  assert.match(workflow, /tags:\s*\n\s*- "\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/);
  assert.match(workflow, /pnpm --filter @egresskit\/app-egressd build/);
  assert.match(workflow, /dist\/control-cli-bin\.js/);
  assert.match(workflow, /dist\/cli\.js/);
  assert.match(workflow, /release\/egresskit-app-egressd-\*\.tgz/);
  assert.doesNotMatch(workflow, /release\/egresskit-egressd-\*\.tgz/);
  assert.match(workflow, /archive=.*egresskit-\$\{\{ matrix\.name \}\}\.tgz/);
  assert.match(workflow, /pnpm --dir .* add "\$archive"/);
  assert.doesNotMatch(workflow, /add --offline "\$archive"/);
  assert.match(workflow, /node_modules\/\.bin\/egresskit/);
  assert.match(workflow, /node_modules\/\.bin\/egressd/);
  assert.doesNotMatch(workflow, /host-artifacts:[\s\S]*?- run: pnpm verify/);
  assert.match(workflow, /docker\/build-push-action/);
  assert.match(workflow, /linux\/amd64,linux\/arm64/);
  assert.match(workflow, /gh release (create|upload)/);
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actionlint/);
  assert.doesNotMatch(workflow, /refs\/tags\/v/);
  assert.match(workflow, /quality:[\s\S]*?run: pnpm verify/);
  assert.match(workflow, /needs: \[quality, docker-validation\]/);
  assert.match(workflow, /needs: \[quality, host-artifacts, docker-publish\]/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /127\.0\.0\.1::8787/);
});
