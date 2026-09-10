#!/usr/bin/env node

import { join } from "node:path";
import { defaultStateDirectory } from "./config.js";

import { runControlCli } from "./control-cli.js";
import { UnixControlClient } from "./control-client.js";
import { MihomoInstallError, runMihomoInstallCommand } from "./mihomo-install.js";

async function main(): Promise<void> {
  const stateDirectory = defaultStateDirectory();
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "runtime" && arguments_[1] === "install") {
    await runMihomoInstallCommand(arguments_.slice(2), stateDirectory, (value) =>
      process.stdout.write(value),
    );
    return;
  }
  const socketPath = join(stateDirectory, "egressd.sock");
  const adminToken = process.env.EGRESSKIT_ADMIN_TOKEN;

  if (!adminToken) throw new Error("EGRESSKIT_ADMIN_TOKEN is required");
  await runControlCli(
    arguments_,
    {
      readStdin: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString();
      },
      write: (value) => process.stdout.write(value),
    },
    new UnixControlClient({ adminToken, socketPath }),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${error instanceof MihomoInstallError ? `${error.code}: ` : ""}${message}\n`,
  );
  process.exitCode = 1;
});
