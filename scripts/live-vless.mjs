import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function cleanChildEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("EGRESSKIT_LIVE_")),
  );
}

export function validateTargetUrl(value) {
  const target = new URL(value);
  if (target.protocol !== "https:") throw new Error("live target must use HTTPS");
  return target;
}

export function isVerifiedExit(direct, observed) {
  return isIP(direct) !== 0 && isIP(observed) !== 0 && direct !== observed;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the authorized live test`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  if (result.status !== 0) throw new Error(`${command} failed during the live test`);
  return result.stdout;
}

function waitForStart(child) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error("egressd startup timed out")), 10_000);
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error("egressd exited before startup"));
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"egressd.started"')) continue;
        try {
          const address = JSON.parse(line);
          if (!Number.isInteger(address.port)) throw new Error("invalid port");
          clearTimeout(timeout);
          child.off("error", fail);
          child.off("exit", fail);
          resolve(address);
        } catch {
          clearTimeout(timeout);
          reject(new Error("egressd emitted an invalid startup event"));
        }
        return;
      }
    });
  });
}

async function stopDaemon(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function parseObservedIp(output) {
  try {
    const value = JSON.parse(output).ip;
    return typeof value === "string" ? value : undefined;
  } catch {
    throw new Error("target returned invalid JSON");
  }
}

export async function main() {
  const subscriptionUrl = required("EGRESSKIT_LIVE_SUBSCRIPTION_URL");
  const targetUrl = validateTargetUrl(required("EGRESSKIT_LIVE_TARGET_URL")).href;
  const mihomoBinary = required("EGRESSKIT_MIHOMO_BINARY");
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-live-vless-"));
  const adminToken = randomBytes(24).toString("hex");
  const proxyToken = randomBytes(24).toString("hex");
  const childEnvironment = cleanChildEnvironment(process.env);
  let daemon;
  const interrupt = () => daemon?.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    run("pnpm", ["--filter", "@egresskit/egressd", "build"], { env: childEnvironment });
    daemon = spawn("node", ["apps/egressd/dist/cli.js"], {
      env: {
        ...childEnvironment,
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
        ...childEnvironment,
        EGRESSKIT_ADMIN_TOKEN: adminToken,
        EGRESSKIT_STATE_DIRECTORY: stateDirectory,
      },
      input: subscriptionUrl,
    });
    const curlBase = ["--fail", "--silent", "--show-error", "--max-time", "30"];
    const direct = parseObservedIp(
      run("curl", [...curlBase, targetUrl], { env: childEnvironment }),
    );
    const observed = parseObservedIp(
      run(
        "curl",
        [
          ...curlBase,
          "--noproxy",
          "",
          "--proxy",
          `http://127.0.0.1:${address.port}`,
          "--proxy-user",
          `rotate:${proxyToken}`,
          targetUrl,
        ],
        { env: childEnvironment },
      ),
    );
    if (!isVerifiedExit(direct, observed)) {
      throw new Error("the target did not observe a distinct valid proxy exit");
    }
    process.stdout.write(
      `${JSON.stringify({ localImplementation: "passed", mihomoAcceptance: "passed", targetReachability: "passed", realExitVerification: "passed" })}\n`,
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await stopDaemon(daemon);
    await rm(stateDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "live test failed"}\n`);
    process.exitCode = 1;
  });
}
