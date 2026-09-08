#!/usr/bin/env node

import { join } from "node:path";

import { loadConfig } from "./config.js";
import { startEgressd } from "./daemon.js";
import { assertMihomoExecutable } from "./mihomo-install.js";
import { checkMihomoConfig, ManagedMihomoRuntime } from "./mihomo-runtime.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.mihomoBinary) await assertMihomoExecutable(config.mihomoBinary);
  const mihomoRuntime =
    config.mihomoListener === undefined
      ? new ManagedMihomoRuntime({
          ...(config.mihomoBinary === undefined ? {} : { binary: config.mihomoBinary }),
          directory: join(config.stateDirectory, "mihomo-runtime"),
        })
      : {
          apply: async (mihomoConfig: Parameters<typeof checkMihomoConfig>[0]) => {
            if (mihomoConfig.proxies.length !== 1) {
              throw new Error("configured Mihomo listener supports exactly one imported node");
            }
            const node = mihomoConfig.proxies[0];
            return new Map(node ? [[node.name, config.mihomoListener as URL]] : []);
          },
          check: checkMihomoConfig,
          removeListener: async () => {
            throw new Error("the configured external Mihomo listener cannot be removed");
          },
        };
  const daemon = await startEgressd({
    ...config,
    mihomoRuntime,
  });

  process.stdout.write(`${JSON.stringify({ event: "egressd.started", ...daemon.address })}\n`);

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  await daemon.close();
  process.stdout.write(`${JSON.stringify({ event: "egressd.stopped", signal })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ event: "egressd.failed", message })}\n`);
  process.exitCode = 1;
});
