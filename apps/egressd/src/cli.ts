#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { startEgressd } from "./daemon.js";
import { checkMihomoConfig } from "./mihomo-runtime.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const daemon = await startEgressd({
    ...config,
    ...(config.mihomoListener === undefined
      ? {}
      : {
          mihomoRuntime: {
            apply: async (mihomoConfig) => {
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
          },
        }),
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
