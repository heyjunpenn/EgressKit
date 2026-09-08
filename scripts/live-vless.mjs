import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the authorized live test`);
  return value;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} failed during the live test`);
  return result.stdout;
};

const waitForStart = (child) =>
  new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("egressd startup timed out")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.includes('"egressd.started"'));
      if (!line) return;
      clearTimeout(timeout);
      resolve(JSON.parse(line));
    });
    child.once("exit", () => reject(new Error("egressd exited before startup")));
  });

const subscriptionUrl = required("EGRESSKIT_LIVE_SUBSCRIPTION_URL");
const targetUrl = required("EGRESSKIT_LIVE_TARGET_URL");
const mihomoBinary = required("EGRESSKIT_MIHOMO_BINARY");
const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-live-vless-"));
const adminToken = randomBytes(24).toString("hex");
const proxyToken = randomBytes(24).toString("hex");
let daemon;

try {
  run("pnpm", ["--filter", "@egresskit/egressd", "build"]);
  daemon = spawn("node", ["apps/egressd/dist/cli.js"], {
    env: {
      ...process.env,
      EGRESSKIT_ADMIN_TOKEN: adminToken,
      EGRESSKIT_MIHOMO_BINARY: mihomoBinary,
      EGRESSKIT_PORT: "0",
      EGRESSKIT_PROXY_TOKEN: proxyToken,
      EGRESSKIT_STATE_DIRECTORY: stateDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = await waitForStart(daemon);
  run("node", ["apps/egressd/dist/control-cli-bin.js", "subscription", "add", "--redact"], {
    env: {
      ...process.env,
      EGRESSKIT_ADMIN_TOKEN: adminToken,
      EGRESSKIT_STATE_DIRECTORY: stateDirectory,
    },
    input: subscriptionUrl,
  });
  const direct = JSON.parse(run("curl", ["--fail", "--silent", "--show-error", targetUrl])).ip;
  const observed = JSON.parse(
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "30",
      "--proxy",
      `http://127.0.0.1:${address.port}`,
      "--proxy-user",
      `rotate:${proxyToken}`,
      targetUrl,
    ]),
  ).ip;
  if (typeof direct !== "string" || typeof observed !== "string" || direct === observed) {
    throw new Error("the target did not observe a distinct valid proxy exit");
  }
  process.stdout.write(
    `${JSON.stringify({ localImplementation: "passed", mihomoAcceptance: "passed", targetReachability: "passed", realExitVerification: "passed" })}\n`,
  );
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
  await rm(stateDirectory, { force: true, recursive: true });
}
