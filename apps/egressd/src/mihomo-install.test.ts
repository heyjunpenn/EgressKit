import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertMihomoExecutable,
  installMihomo,
  MihomoInstallError,
  resolveMihomoBinary,
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
    validateExecutable: async () => undefined,
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
  await assert.rejects(
    assertMihomoExecutable(directory),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "not-executable",
  );
  const invalidExecutable = join(directory, "invalid");
  await writeFile(invalidExecutable, "not an executable", { mode: 0o700 });
  await assert.rejects(
    assertMihomoExecutable(invalidExecutable),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "not-executable",
  );
  const impostor = join(directory, "impostor");
  await writeFile(impostor, "#!/bin/sh\necho unrelated v1.19.30\n", { mode: 0o700 });
  await assert.rejects(
    assertMihomoExecutable(impostor),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "not-executable",
  );
  const wrongVersion = join(directory, "wrong-version");
  await writeFile(wrongVersion, "#!/bin/sh\necho Mihomo Meta v1.19.29\n", { mode: 0o700 });
  await assert.rejects(
    assertMihomoExecutable(wrongVersion),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "not-executable",
  );
  const supported = join(directory, "supported");
  await writeFile(supported, "#!/bin/sh\necho Mihomo Meta v1.19.30\n", { mode: 0o700 });
  await assert.doesNotReject(assertMihomoExecutable(supported));
});

test("daemon binary resolution discovers the default explicit installation", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-binary-resolution-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const installed = join(stateDirectory, "mihomo", "mihomo");
  await mkdir(join(stateDirectory, "mihomo"));
  await writeFile(installed, "binary", { mode: 0o700 });

  assert.equal(
    await resolveMihomoBinary(stateDirectory, undefined, async () => undefined),
    installed,
  );
  assert.equal(await resolveMihomoBinary(join(stateDirectory, "missing")), "mihomo");
});

test("bounded downloads and failed executable validation preserve an existing destination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-install-bounds-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const destination = join(directory, "mihomo");
  await writeFile(destination, "old-binary", { mode: 0o700 });
  const oversized = gzipSync("new-binary");

  await assert.rejects(
    installMihomo({
      asset: {
        archive: "mihomo-test.gz",
        sha256: createHash("sha256").update(oversized).digest("hex"),
      },
      destination,
      fetch: async () => new Response(new Uint8Array(oversized)),
      maximumArchiveBytes: oversized.length - 1,
    }),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "download-failed",
  );
  assert.equal(await readFile(destination, "utf8"), "old-binary");

  await assert.rejects(
    installMihomo({
      asset: {
        archive: "mihomo-test.gz",
        sha256: createHash("sha256").update(oversized).digest("hex"),
      },
      destination,
      fetch: async () => new Response(new Uint8Array(oversized)),
      maximumBinaryBytes: 3,
    }),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "download-failed",
  );
  assert.equal(await readFile(destination, "utf8"), "old-binary");

  await assert.rejects(
    installMihomo({
      asset: {
        archive: "mihomo-test.gz",
        sha256: createHash("sha256").update(oversized).digest("hex"),
      },
      destination,
      fetch: async () => new Response(new Uint8Array(oversized)),
      validateExecutable: async () => {
        throw new MihomoInstallError("not-executable", "injected validation failure");
      },
    }),
    (error: unknown) => error instanceof MihomoInstallError && error.code === "not-executable",
  );
  assert.equal(await readFile(destination, "utf8"), "old-binary");
});
