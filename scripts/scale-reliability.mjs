import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export function percentile(values, quantile) {
  if (values.length === 0) throw new Error("percentile requires observations");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

export function verdict(measured, target) {
  return { measured, passed: measured >= target, target };
}

const yamlForNodes = (count, revision = 0) =>
  `proxies:\n${Array.from({ length: count }, (_, index) => {
    const suffix = String(index + revision * count)
      .padStart(12, "0")
      .slice(-12);
    return `  - { name: node-${index}, type: vless, server: 192.0.2.1, port: 443, uuid: 00000000-0000-4000-8000-${suffix} }`;
  }).join("\n")}\n`;

async function startConnectListener() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.includes("\r\n\r\n")) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        request = "";
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
    port: address.port,
  };
}

async function openTunnel(address) {
  const startedAt = performance.now();
  const socket = connect(address.port, address.host);
  const timeout = setTimeout(() => socket.destroy(new Error("CONNECT timed out")), 10_000);
  await once(socket, "connect");
  socket.write("CONNECT benchmark.invalid:443 HTTP/1.1\r\nHost: benchmark.invalid:443\r\n\r\n");
  const [chunk] = await once(socket, "data");
  const status = /^HTTP\/1\.1 (\d{3})/.exec(chunk.toString())?.[1] ?? "UNKNOWN";
  if (status !== "200") {
    clearTimeout(timeout);
    socket.destroy();
    throw Object.assign(new Error("CONNECT failed"), { code: `HTTP_${status}` });
  }
  clearTimeout(timeout);
  return { latencyMs: performance.now() - startedAt, socket };
}

async function directConnectLatency(port) {
  const startedAt = performance.now();
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.destroy();
  return performance.now() - startedAt;
}

export async function runBenchmark({ soakSeconds = 60 } = {}) {
  const [{ startEgressd }, subscription, schedulerModule, sessionModule] = await Promise.all([
    import("../apps/egressd/dist/daemon.js"),
    import("../apps/egressd/dist/subscription.js"),
    import("../apps/egressd/dist/scheduler.js"),
    import("../apps/egressd/dist/session.js"),
  ]);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "egresskit-benchmark-"));
  const listeners = [];
  let daemon;
  try {
    const parseStarted = performance.now();
    const parsed = subscription.importLocalVlessYaml(yamlForNodes(500), {
      firstListenerPort: 20_000,
    });
    const subscriptionParseMs = performance.now() - parseStarted;

    for (let index = 0; index < 400; index += 1) listeners.push(await startConnectListener());
    const activeListeners = 100;
    const upstream = listeners[0];
    let unexpectedExit;
    let mihomoRestarts = 0;
    daemon = await startEgressd({
      checkMihomoListener: async () => undefined,
      host: "127.0.0.1",
      log: () => undefined,
      mihomoRuntime: {
        apply: async (config) =>
          new Map(
            config.proxies.map((node, index) => {
              const numericSuffix = Number(node.uuid.slice(-12));
              const bank = Math.floor(numericSuffix / 100) * 100;
              return [node.name, new URL(`http://127.0.0.1:${listeners[bank + index].port}`)];
            }),
          ),
        check: async () => undefined,
        onUnexpectedExit: (listener) => {
          unexpectedExit = listener;
          return () => {
            unexpectedExit = undefined;
          };
        },
        removeListener: async () => undefined,
        restart: async () => {
          mihomoRestarts += 1;
        },
      },
      port: 0,
      proxyAuthentication: false,
    });
    await daemon.importLocalSubscription(yamlForNodes(100));

    const gatewaySamples = [];
    const directSamples = [];
    const gatewayAddedSamples = [];
    for (let index = 0; index < 200; index += 1) {
      const directLatency = await directConnectLatency(upstream.port);
      directSamples.push(directLatency);
      const tunnel = await openTunnel(daemon.address);
      gatewaySamples.push(tunnel.latencyMs);
      gatewayAddedSamples.push(Math.max(0, tunnel.latencyMs - directLatency));
      tunnel.socket.destroy();
    }
    const gatewayAddedP95Ms = percentile(gatewayAddedSamples, 0.95);

    const tunnelResults = await Promise.allSettled(
      Array.from({ length: 1_000 }, () => openTunnel(daemon.address)),
    );
    const tunnels = tunnelResults
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const concurrentConnects = tunnels.length;
    for (const tunnel of tunnels) tunnel.socket.destroy();

    const candidate = schedulerModule.createSchedulerCandidate(
      "session-node",
      new URL(`http://127.0.0.1:${upstream.port}`),
    );
    const sessionScheduler = new schedulerModule.RotateScheduler([candidate]);
    const sessions = new sessionModule.SoftStickySessions({ scheduler: sessionScheduler });
    for (let index = 0; index < 10_000; index += 1) {
      sessions.acquire(`benchmark-${index}`)?.release();
    }
    const activeSessions = sessions.countActiveSessions();

    const database = new DatabaseSync(join(temporaryDirectory, "soak.sqlite"));
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT)",
    );
    const soak = {
      connectAttempts: 0,
      connectFailures: 0,
      connectFailureReasons: {},
      drainingCycles: 0,
      sqliteWalWrites: 0,
      subscriptionUpdates: 0,
    };
    const deadline = Date.now() + soakSeconds * 1_000;
    await Promise.all([
      (async () => {
        while (Date.now() < deadline) {
          const traffic = await Promise.allSettled(
            Array.from({ length: 32 }, () => openTunnel(daemon.address)),
          );
          soak.connectAttempts += traffic.length;
          for (const result of traffic) {
            if (result.status === "fulfilled") result.value.socket.destroy();
            else {
              soak.connectFailures += 1;
              const reason =
                result.reason && typeof result.reason === "object" && "code" in result.reason
                  ? String(result.reason.code)
                  : "OTHER";
              soak.connectFailureReasons[reason] = (soak.connectFailureReasons[reason] ?? 0) + 1;
            }
          }
          database
            .prepare("INSERT INTO events(value) VALUES (?)")
            .run(String(soak.sqliteWalWrites));
          database.prepare("SELECT COUNT(*) FROM events").get();
          soak.sqliteWalWrites += 1;
        }
      })(),
      (async () => {
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          if (Date.now() >= deadline) break;
          await daemon.importLocalSubscription(yamlForNodes(100, soak.subscriptionUpdates + 1));
          soak.subscriptionUpdates += 1;
          soak.drainingCycles += 1;
          unexpectedExit?.();
        }
      })(),
    ]);
    database.close();
    const soakResult = { ...soak, mihomoRestarts };

    const result = {
      measurements: {
        activeListeners: verdict(activeListeners, 100),
        activeSessions: verdict(activeSessions, 10_000),
        concurrentConnects: verdict(concurrentConnects, 1_000),
        gatewayAddedConnectP95Ms: {
          measured: Number(gatewayAddedP95Ms.toFixed(3)),
          passed: gatewayAddedP95Ms < 20,
          targetMaximum: 20,
        },
        subscriptionNodes: verdict(parsed.nodes.length, 500),
        soakReliability: {
          measuredSuccessRate:
            soak.connectAttempts === 0
              ? 0
              : Number(
                  ((soak.connectAttempts - soak.connectFailures) / soak.connectAttempts).toFixed(6),
                ),
          passed: soak.connectFailures === 0,
          target: "zero CONNECT failures during the fixed soak",
        },
      },
      raw: {
        directConnectP95Ms: Number(percentile(directSamples, 0.95).toFixed(3)),
        gatewayConnectP95Ms: Number(percentile(gatewaySamples, 0.95).toFixed(3)),
        soak: soakResult,
        soakSeconds,
        subscriptionParseMs: Number(subscriptionParseMs.toFixed(3)),
      },
    };
    return result;
  } finally {
    await daemon?.close();
    await Promise.all(listeners.map((listener) => listener.close()));
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const soakSeconds = Number(process.argv[2] ?? "60");
  runBenchmark({ soakSeconds })
    .then((result) => process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "benchmark failed"}\n`);
      process.exitCode = 1;
    });
}
