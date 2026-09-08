#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";

import { runControlCli } from "./control-cli.js";
import { UnixControlClient } from "./control-client.js";
import { MihomoInstallError, runMihomoInstallCommand } from "./mihomo-install.js";

async function main(): Promise<void> {
  const stateDirectory =
    process.env.EGRESSKIT_STATE_DIRECTORY ??
    (process.env.XDG_STATE_HOME
      ? join(process.env.XDG_STATE_HOME, "egresskit")
      : join(homedir(), ".local", "state", "egresskit"));
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "runtime" && arguments_[1] === "install") {
    await runMihomoInstallCommand(arguments_.slice(2), stateDirectory, (value) =>
      process.stdout.write(value),
    );
    return;
  }
  const socketPath = process.env.EGRESSKIT_CONTROL_SOCKET ?? join(stateDirectory, "egressd.sock");
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
