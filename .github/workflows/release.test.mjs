import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("./release.yml", import.meta.url);

test("the release workflow validates and publishes only the Docker image", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /tags:\s*\n\s*- "\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*release_tag:/);
  assert.match(workflow, /docker\/build-push-action/);
  assert.match(workflow, /linux\/amd64,linux\/arm64/);
  assert.match(workflow, /username: \$\{\{ secrets\.DOCKERHUB_USERNAME \}\}/);
  assert.match(workflow, /password: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/);
  assert.match(workflow, /images: heyjunpenn\/egresskit/);
  assert.match(workflow, /ref: \$\{\{ inputs\.release_tag \|\| github\.ref \}\}/);
  assert.match(workflow, /type=raw,value=\$\{\{ inputs\.release_tag \}\}/);
  assert.doesNotMatch(workflow, /ghcr\.io\/heyjunpenn\/egresskit/);
  assert.doesNotMatch(workflow, /host-artifacts:/);
  assert.doesNotMatch(workflow, /github-release:/);
  assert.doesNotMatch(workflow, /actions\/(upload|download)-artifact/);
  assert.doesNotMatch(workflow, /gh release (create|upload)/);
  assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/);
  assert.doesNotMatch(workflow, /packages: write/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /actionlint/);
  assert.doesNotMatch(workflow, /refs\/tags\/v/);
  assert.match(workflow, /quality:[\s\S]*?run: pnpm verify/);
  assert.match(workflow, /needs: \[quality, docker-validation\]/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /127\.0\.0\.1::8787/);
});

test("every release job times out after ten minutes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const job of ["workflow-lint", "quality", "docker-validation", "docker-publish"]) {
    assert.match(workflow, new RegExp(`\\n  ${job}:[\\s\\S]*?\\n    timeout-minutes: 10`));
  }
});

test("a Docker release publishes both its version and latest", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /type=raw,value=latest/);
});
