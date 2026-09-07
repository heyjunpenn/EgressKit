#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { startEgressd } from "./daemon.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const daemon = await startEgressd(config);

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
