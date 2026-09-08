import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deploymentUrl = new URL("./deployment.md", import.meta.url);

test("deployment docs disclose the exact v1 support and state-security contract", async () => {
  const deployment = await readFile(deploymentUrl, "utf8");

  assert.match(deployment, /Linux x64/);
  assert.match(deployment, /Linux arm64/);
  assert.match(deployment, /macOS x64/);
  assert.match(deployment, /macOS arm64/);
  assert.match(deployment, /Windows[^\n]*不在 v1/);
  assert.match(deployment, /SQLite[^\n]*明文/);
  assert.match(deployment, /状态目录[^\n]*(敏感|秘密)/);
  assert.match(deployment, /备份[^\n]*(凭据|敏感|秘密)/);
  assert.match(deployment, /EGRESSKIT_PROXY_TOKEN/);
  assert.doesNotMatch(deployment, /EGRESSKIT_PROXY_TOKENS/);
  assert.match(deployment, /127\.0\.0\.1:8787:8787/);
  assert.match(deployment, /GitHub Release/);
  assert.match(deployment, /不从 npm registry/);
  assert.match(deployment, /SBOM/);
  assert.match(deployment, /独立[^\n]*`pnpm verify`/);
  assert.match(deployment, /四种[^\n]*构建、打包、安装/);
});
