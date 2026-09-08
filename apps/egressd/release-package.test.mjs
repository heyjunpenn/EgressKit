import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("release metadata identifies EgressKit and redistributed Mihomo licenses", async () => {
  const [rootPackage, appPackage, notice, apache, gpl] = await Promise.all([
    text("package.json"),
    text("apps/egressd/package.json"),
    text("THIRD_PARTY_NOTICES.md"),
    text("LICENSE"),
    text("licenses/Mihomo-GPL-3.0.txt"),
  ]);

  assert.equal(JSON.parse(rootPackage).license, "Apache-2.0");
  assert.equal(JSON.parse(appPackage).license, "Apache-2.0");
  assert.match(apache, /Apache License[\s\S]*Version 2\.0/);
  assert.match(gpl, /GNU GENERAL PUBLIC LICENSE[\s\S]*Version 3/);
  assert.match(notice, /MetaCubeX\/mihomo/);
  assert.match(notice, /v1\.19\.30/);
  assert.match(notice, /GPL-3\.0/);
  assert.match(notice, /github\.com\/MetaCubeX\/mihomo\/tree\/v1\.19\.30/);
});

test("the packaged release contains both built entry points and legal files", async () => {
  await execFileAsync("pnpm", ["--filter", "@egresskit/egressd", "build"], { cwd: root });
  const { stdout } = await execFileAsync(
    "pnpm",
    ["--filter", "@egresskit/egressd", "pack", "--pack-destination", "release"],
    { cwd: root },
  );
  const archive = stdout.trim().split("\n").at(-1);
  assert.ok(archive);
  const installation = await mkdtemp(join(tmpdir(), "egresskit-package-install-"));
  try {
    const { stdout: listing } = await execFileAsync("tar", ["-tzf", archive], { cwd: root });

    for (const path of [
      "package/dist/control-cli-bin.js",
      "package/dist/cli.js",
      "package/LICENSE",
      "package/THIRD_PARTY_NOTICES.md",
      "package/licenses/Mihomo-GPL-3.0.txt",
    ]) {
      assert.match(listing, new RegExp(`^${path}$`, "m"));
    }

    await execFileAsync("npm", ["install", "--ignore-scripts", "--no-package-lock", archive], {
      cwd: installation,
    });
    const binDirectory = join(installation, "node_modules", ".bin");
    await assert.rejects(
      execFileAsync(join(binDirectory, "egresskit"), ["runtime", "install", "--destination"]),
      (error) => error.code === 1 && error.stderr.includes("--destination requires a path"),
    );
    await assert.rejects(
      execFileAsync(join(binDirectory, "egressd"), [], {
        env: {
          ...process.env,
          EGRESSKIT_ADMIN_TOKEN: "package-test-admin",
          EGRESSKIT_HOST: "0.0.0.0",
          EGRESSKIT_PROXY_TOKEN: "",
        },
      }),
      (error) =>
        error.code === 1 && error.stderr.includes("EGRESSKIT_PROXY_TOKEN must not be empty"),
    );
  } finally {
    await unlink(archive);
    await rm(installation, { recursive: true, force: true });
  }
});
