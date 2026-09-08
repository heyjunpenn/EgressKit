import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";

import type { ImportedVlessRevision } from "./subscription.js";

type MihomoConfig = ImportedVlessRevision["mihomoConfig"];

export interface MihomoStaticCheckOptions {
  binary?: string;
  run?: (binary: string, arguments_: readonly string[]) => Promise<void>;
}

export async function checkMihomoConfig(
  config: MihomoConfig,
  options: MihomoStaticCheckOptions = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-mihomo-check-"));
  const candidatePath = join(directory, "candidate.yaml");
  try {
    await writeFile(candidatePath, stringify(config), { encoding: "utf8", mode: 0o600 });
    await (options.run ?? runMihomo)(options.binary ?? "mihomo", ["-t", "-f", candidatePath]);
  } catch (error) {
    throw new Error("official Mihomo static check failed", { cause: error });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function runMihomo(binary: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Mihomo static check exited with ${signal ?? code ?? "unknown status"}`));
    });
  });
}
