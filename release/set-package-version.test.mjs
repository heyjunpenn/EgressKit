import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = new URL("./set-package-version.mjs", import.meta.url);

test("a release tag stamps the package with the exact semantic version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-release-version-"));
  const packagePath = join(directory, "package.json");
  await writeFile(packagePath, '{"name":"fixture","version":"0.0.0"}\n');

  await execFileAsync(process.execPath, [script.pathname, "v1.2.3-rc.1+build.5", packagePath]);

  assert.equal(JSON.parse(await readFile(packagePath, "utf8")).version, "1.2.3-rc.1+build.5");
});

test("invalid or ambiguous release tags are rejected without changing metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-release-version-"));
  const packagePath = join(directory, "package.json");
  const original = '{"name":"fixture","version":"0.0.0"}\n';
  await writeFile(packagePath, original);

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname, "v01.2.3", packagePath]),
    /release tag must be a valid v-prefixed semantic version/,
  );
  assert.equal(await readFile(packagePath, "utf8"), original);
});
