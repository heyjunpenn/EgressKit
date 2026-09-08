#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";

import { runControlCli } from "./control-cli.js";
import { UnixControlClient } from "./control-client.js";

const stateDirectory =
  process.env.EGRESSKIT_STATE_DIRECTORY ??
  (process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "egresskit")
    : join(homedir(), ".local", "state", "egresskit"));
const socketPath = process.env.EGRESSKIT_CONTROL_SOCKET ?? join(stateDirectory, "egressd.sock");
const adminToken = process.env.EGRESSKIT_ADMIN_TOKEN;

if (!adminToken) {
  process.stderr.write("EGRESSKIT_ADMIN_TOKEN is required\n");
  process.exitCode = 1;
} else {
  runControlCli(
    process.argv.slice(2),
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
  ).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
