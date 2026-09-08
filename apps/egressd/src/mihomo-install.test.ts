import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertMihomoExecutable,
  installMihomo,
  MihomoInstallError,
  runMihomoInstallCommand,
  supportedMihomoAsset,
} from "./mihomo-install.js";

test("runtime install command chooses an explicit destination without daemon credentials", async () => {
  const writes: string[] = [];
  const destinations: string[] = [];
  await runMihomoInstallCommand(
    ["--destination", "/opt/egresskit/mihomo"],
    "/state",
    (value) => writes.push(value),
    async ({ destination }) => {
      destinations.push(destination);
      return { path: destination, version: "v1.19.30" };
    },
  );

  assert.deepEqual(destinations, ["/opt/egresskit/mihomo"]);
  assert.deepEqual(JSON.parse(writes.join("")), {
    path: "/opt/egresskit/mihomo",
    version: "v1.19.30",
  });
});

test("package lifecycle scripts never download Mihomo implicitly", async () => {
  const packageDocument = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.equal(packageDocument.scripts?.postinstall, undefined);
  assert.doesNotMatch(JSON.stringify(packageDocument.scripts), /mihomo|download|curl|wget/i);
});

test("installer downloads one pinned official asset, verifies it, and writes an executable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-install-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const archive = gzipSync("official-mihomo");
  const requests: string[] = [];
  const destination = join(directory, "mihomo");

  const result = await installMihomo({
    asset: {
      archive: "mihomo-test.gz",
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
    destination,
    fetch: async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(new Uint8Array(archive));
    },
  });

  assert.deepEqual(requests, [
    "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo-test.gz",
  ]);
  assert.deepEqual(result, { path: destination, version: "v1.19.30" });
  assert.equal(await readFile(destination, "utf8"), "official-mihomo");
  await access(destination, constants.X_OK);
});

test("installer reports unsupported, download, checksum, and executable errors distinctly", async (t) => {
  assert.throws(() => supportedMihomoAsset("win32", "x64"), /unsupported platform/);
  await assert.rejects(
    installMihomo({
      asset: { archive: "mihomo-test.gz", sha256: "00".repeat(32) },
      destination: "/unused",
      fetch: async () => new Response("no", { status: 503 }),
    }),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "download-failed",
  );
  const directory = await mkdtemp(join(tmpdir(), "egresskit-install-errors-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await assert.rejects(
    installMihomo({
      asset: { archive: "mihomo-test.gz", sha256: "00".repeat(32) },
      destination: join(directory, "mihomo"),
      fetch: async () => new Response(new Uint8Array(gzipSync("tampered"))),
    }),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "checksum-failed",
  );
  const nonExecutable = join(directory, "existing");
  await writeFile(nonExecutable, "binary", { mode: 0o600 });
  await assert.rejects(
    assertMihomoExecutable(nonExecutable),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "not-executable",
  );
});
