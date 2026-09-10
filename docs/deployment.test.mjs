import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deploymentUrl = new URL("./deployment.md", import.meta.url);

test("deployment docs disclose the exact v1 support and state-security contract", async () => {
  const deployment = await readFile(deploymentUrl, "utf8");

  assert.match(deployment, /linux\/amd64/);
  assert.match(deployment, /linux\/arm64/);
  assert.match(deployment, /SQLite[^\n]*明文/);
  assert.match(deployment, /状态目录[^\n]*(敏感|秘密)/);
  assert.match(deployment, /备份[^\n]*(凭据|敏感|秘密)/);
  assert.doesNotMatch(deployment, /-e EGRESSKIT_PROXY_TOKEN/);
  assert.doesNotMatch(deployment, /EGRESSKIT_PROXY_TOKENS/);
  assert.match(deployment, /127\.0\.0\.1:8787:8787/);
  assert.match(deployment, /仅通过 Docker Hub 分发/);
  assert.doesNotMatch(deployment, /GitHub Release/);
  assert.doesNotMatch(deployment, /宿主机归档[^\n]*正式下载渠道/);
  assert.match(deployment, /SBOM/);
  assert.match(deployment, /完整\s*`pnpm verify`/);
});
