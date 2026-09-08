import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const MIHOMO_VERSION = "v1.19.30";
const RELEASE_BASE = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}`;
const MAXIMUM_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_BINARY_BYTES = 256 * 1024 * 1024;

export interface MihomoAsset {
  archive: string;
  sha256: string;
}

const ASSETS: Readonly<Record<string, MihomoAsset>> = {
  "darwin-arm64": {
    archive: "mihomo-darwin-arm64-v1.19.30.gz",
    sha256: "2c7f3a7904fa1cee291e124123e630e7b1ebd13765dd9bf26c0a28432004d9f4",
  },
  "darwin-x64": {
    archive: "mihomo-darwin-amd64-compatible-v1.19.30.gz",
    sha256: "6e75de0732e8afabe413ff7c235e8f16226ce136672371c60787cbf9607402c5",
  },
  "linux-arm64": {
    archive: "mihomo-linux-arm64-v1.19.30.gz",
    sha256: "58896873736d28628f66de3677c8654fa0f180662523148e136cff4f6e890069",
  },
  "linux-x64": {
    archive: "mihomo-linux-amd64-compatible-v1.19.30.gz",
    sha256: "db214c7a2517e63c150d123178d16d102e03a241ccdae4e5e07ffbe9cf56c6f9",
  },
};

export type MihomoInstallErrorCode =
  | "checksum-failed"
  | "download-failed"
  | "not-executable"
  | "unsupported-platform";

export class MihomoInstallError extends Error {
  constructor(
    readonly code: MihomoInstallErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function supportedMihomoAsset(
  platform = process.platform,
  arch = process.arch,
): MihomoAsset {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new MihomoInstallError(
      "unsupported-platform",
      `unsupported platform for Mihomo ${MIHOMO_VERSION}: ${platform}-${arch}`,
    );
  }
  return asset;
}

export async function installMihomo(options: {
  asset?: MihomoAsset;
  destination: string;
  downloadTimeoutMs?: number;
  fetch?: typeof fetch;
  maximumArchiveBytes?: number;
  maximumBinaryBytes?: number;
  validateExecutable?: (path: string) => Promise<void>;
}): Promise<{ path: string; version: string }> {
  const asset = options.asset ?? supportedMihomoAsset();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${RELEASE_BASE}/${asset.archive}`, {
      signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 60_000),
    });
  } catch {
    throw new MihomoInstallError("download-failed", "Mihomo download failed");
  }
  if (!response.ok) {
    throw new MihomoInstallError(
      "download-failed",
      `Mihomo download failed with HTTP ${response.status}`,
    );
  }
  let archive: Buffer;
  try {
    archive = await readBoundedResponse(
      response,
      options.maximumArchiveBytes ?? MAXIMUM_ARCHIVE_BYTES,
    );
  } catch (error) {
    if (error instanceof MihomoInstallError) throw error;
    throw new MihomoInstallError("download-failed", "Mihomo download failed");
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== asset.sha256) {
    throw new MihomoInstallError("checksum-failed", "Mihomo SHA-256 verification failed");
  }
  let binary: Buffer;
  try {
    binary = gunzipSync(archive, {
      maxOutputLength: options.maximumBinaryBytes ?? MAXIMUM_BINARY_BYTES,
    });
  } catch {
    throw new MihomoInstallError("download-failed", "downloaded Mihomo archive is invalid");
  }
  const parent = dirname(options.destination);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const temporaryDirectory = await mkdtemp(join(parent, ".mihomo-install-"));
  const temporaryPath = join(temporaryDirectory, "mihomo");
  try {
    await writeFile(temporaryPath, binary, { mode: 0o700 });
    await chmod(temporaryPath, 0o700);
    await (options.validateExecutable ?? assertMihomoExecutable)(temporaryPath);
    await rename(temporaryPath, options.destination);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  return { path: options.destination, version: MIHOMO_VERSION };
}

export async function assertMihomoExecutable(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    await access(path, constants.X_OK);
    await runVersionProbe(path);
  } catch {
    throw new MihomoInstallError("not-executable", `Mihomo binary is not executable: ${path}`);
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel();
    throw new MihomoInstallError("download-failed", "Mihomo download exceeds size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new MihomoInstallError("download-failed", "Mihomo download exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function runVersionProbe(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["-v"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let outputSize = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const capture = (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 4_096) {
        child.kill("SIGKILL");
        finish(new Error("version probe output exceeds limit"));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("version probe timed out"));
    }, 5_000);
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        finish(new Error(`version probe exited ${String(code)}`));
      } else if (!/mihomo/i.test(output) || !/(?:^|\s)v1\.19\.30(?:\s|$)/.test(output)) {
        finish(new Error(`version probe did not identify Mihomo ${MIHOMO_VERSION}`));
      } else {
        finish();
      }
    });
  });
}

export async function resolveMihomoBinary(
  stateDirectory: string,
  explicitPath?: string,
  validate: (path: string) => Promise<void> = assertMihomoExecutable,
): Promise<string> {
  if (explicitPath) {
    await validate(explicitPath);
    return explicitPath;
  }
  const installedPath = join(stateDirectory, "mihomo", "mihomo");
  try {
    await stat(installedPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "mihomo";
    throw error;
  }
  await validate(installedPath);
  return installedPath;
}

export async function runMihomoInstallCommand(
  arguments_: readonly string[],
  stateDirectory: string,
  write: (value: string) => void,
  install: typeof installMihomo = installMihomo,
): Promise<void> {
  const destinationIndex = arguments_.indexOf("--destination");
  const destination =
    destinationIndex === -1
      ? join(stateDirectory, "mihomo", "mihomo")
      : arguments_[destinationIndex + 1];
  if (!destination) throw new Error("--destination requires a path");
  const allowed = destinationIndex === -1 ? 0 : 2;
  if (arguments_.length !== allowed) {
    throw new Error("usage: egresskit runtime install [--destination PATH]");
  }
  write(`${JSON.stringify(await install({ destination }), undefined, 2)}\n`);
}
