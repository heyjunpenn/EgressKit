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

export function countOpenTunnels(tunnels) {
  return tunnels.filter(
    ({ socket }) => !socket.destroyed && socket.readable === true && socket.writable === true,
  ).length;
}

export function soakReliabilityVerdict(soak, elapsedSeconds, requestedSeconds, journalMode) {
  const measuredSuccessRate =
    soak.connectAttempts === 0
      ? 0
      : Number(((soak.connectAttempts - soak.connectFailures) / soak.connectAttempts).toFixed(6));
  return {
    measuredSuccessRate,
    passed:
      soak.connectAttempts > 0 &&
      soak.connectFailures === 0 &&
      elapsedSeconds >= requestedSeconds &&
      soak.subscriptionUpdates >= 3 &&
      soak.drainingCycles >= 3 &&
      soak.mihomoRestarts >= 3 &&
      soak.sqliteWalReads > 0 &&
      journalMode === "wal",
    target: "zero CONNECT failures with every required soak seam observed",
  };
}

export async function closeAll(cleanups) {
  const results = await Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "benchmark cleanup failed");
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
    activeConnections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    port: address.port,
  };
}

async function openTunnel(address) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = connect(address.port, address.host);
    let header = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.on("error", () => undefined);
        resolve(value);
      }
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(Object.assign(new Error("CONNECT closed"), { code: "CLOSED" }));
    const onData = (chunk) => {
      header += chunk;
      if (header.length > 8_192) {
        finish(Object.assign(new Error("CONNECT header too large"), { code: "INVALID_HEADER" }));
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = /^HTTP\/1\.1 (\d{3})/.exec(header.slice(0, end))?.[1] ?? "UNKNOWN";
      if (status !== "200") {
        finish(Object.assign(new Error("CONNECT failed"), { code: `HTTP_${status}` }));
        return;
      }
      finish(undefined, { latencyMs: performance.now() - startedAt, socket });
    };
    const timeout = setTimeout(
      () => finish(Object.assign(new Error("CONNECT timed out"), { code: "TIMEOUT" })),
      10_000,
    );
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.on("data", onData);
    socket.once("connect", () =>
      socket.write("CONNECT benchmark.invalid:443 HTTP/1.1\r\nHost: benchmark.invalid:443\r\n\r\n"),
    );
  });
}

export async function runBenchmark({ soakSeconds = 60 } = {}) {
  if (!Number.isInteger(soakSeconds) || soakSeconds < 60) {
    throw new Error("benchmark soak duration must be an integer of at least 60 seconds");
  }
  const [{ startEgressd }, subscription, schedulerModule, sessionModule] = await Promise.all([
    import("../apps/egressd/dist/daemon.js"),
    import("../apps/egressd/dist/subscription.js"),
    import("../apps/egressd/dist/scheduler.js"),
    import("../apps/egressd/dist/session.js"),
  ]);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "egresskit-benchmark-"));
  const listeners = [];
  let daemon;
  let database;
  try {
    const parseStarted = performance.now();
    subscription.importLocalVlessYaml(yamlForNodes(500), {
      firstListenerPort: 20_000,
    });
    const subscriptionParseMs = performance.now() - parseStarted;

    const scaleListeners = [];
    let scaleDaemon;
    let scaleDatabase;
    let persistedSubscriptionNodes = 0;
    try {
      for (let index = 0; index < 500; index += 1) {
        scaleListeners.push(await startConnectListener());
      }
      scaleDaemon = await startEgressd({
        checkMihomoListener: async () => undefined,
        host: "127.0.0.1",
        log: () => undefined,
        mihomoRuntime: {
          apply: async (config) =>
            new Map(
              config.proxies.map((node, index) => [
                node.name,
                new URL(`http://127.0.0.1:${scaleListeners[index].port}`),
              ]),
            ),
          check: async () => undefined,
          removeListener: async () => undefined,
        },
        port: 0,
        proxyAuthentication: false,
        stateDirectory: join(temporaryDirectory, "scale-500-state"),
      });
      await scaleDaemon.importLocalSubscription(yamlForNodes(500));
      scaleDatabase = new DatabaseSync(
        join(temporaryDirectory, "scale-500-state", "control.sqlite"),
      );
      persistedSubscriptionNodes = Number(
        scaleDatabase.prepare("SELECT COUNT(*) AS count FROM node_generations").get().count,
      );
      scaleDatabase.close();
      scaleDatabase = undefined;
    } finally {
      await closeAll([
        ...(scaleDatabase ? [async () => scaleDatabase.close()] : []),
        ...(scaleDaemon ? [async () => scaleDaemon.close()] : []),
        ...scaleListeners.map((listener) => async () => listener.close()),
      ]);
    }

    for (let index = 0; index < 400; index += 1) listeners.push(await startConnectListener());
    const upstream = listeners[0];
    let unexpectedExit;
    let mihomoRestarts = 0;
    let activeListeners = 0;
    daemon = await startEgressd({
      checkMihomoListener: async () => undefined,
      host: "127.0.0.1",
      log: () => undefined,
      mihomoRuntime: {
        apply: async (config) => {
          const applied = new Map(
            config.proxies.map((node, index) => {
              const numericSuffix = Number(node.uuid.slice(-12));
              const bank = Math.floor(numericSuffix / 100) * 100;
              return [node.name, new URL(`http://127.0.0.1:${listeners[bank + index].port}`)];
            }),
          );
          activeListeners = new Set([...applied.values()].map((listener) => listener.href)).size;
          return applied;
        },
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
      stateDirectory: join(temporaryDirectory, "soak-state"),
    });
    await daemon.importLocalSubscription(yamlForNodes(100));

    const gatewaySamples = [];
    const directSamples = [];
    const gatewayAddedSamples = [];
    for (let index = 0; index < 200; index += 1) {
      const directTunnel = await openTunnel({ host: "127.0.0.1", port: upstream.port });
      const directLatency = directTunnel.latencyMs;
      directTunnel.socket.destroy();
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
    await new Promise((resolve) => setImmediate(resolve));
    const clientOpenTunnels = countOpenTunnels(tunnels);
    const upstreamOpenTunnels = listeners.reduce(
      (total, listener) => total + listener.activeConnections(),
      0,
    );
    const concurrentConnects = Math.min(clientOpenTunnels, upstreamOpenTunnels);
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

    database = new DatabaseSync(join(temporaryDirectory, "soak-state", "control.sqlite"));
    const sqliteJournalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
    const soak = {
      connectAttempts: 0,
      connectFailures: 0,
      connectFailureReasons: {},
      drainingCycles: 0,
      sqliteWalReads: 0,
      subscriptionUpdates: 0,
    };
    const soakStartedAt = performance.now();
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
          database.prepare("SELECT COUNT(*) FROM subscription_revisions").get();
          soak.sqliteWalReads += 1;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      })(),
      (async () => {
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          if (Date.now() >= deadline) break;
          const heldTunnel = await openTunnel(daemon.address);
          try {
            await daemon.importLocalSubscription(yamlForNodes(100, soak.subscriptionUpdates + 1));
            soak.subscriptionUpdates += 1;
            const draining = Number(
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM listener_port_leases WHERE status = 'draining'",
                )
                .get().count,
            );
            if (draining > 0) soak.drainingCycles += 1;
          } finally {
            heldTunnel.socket.destroy();
          }
          unexpectedExit?.();
        }
      })(),
    ]);
    database.close();
    database = undefined;
    const soakResult = { ...soak, mihomoRestarts };
    const soakElapsedSeconds = Number(((performance.now() - soakStartedAt) / 1_000).toFixed(3));

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
        subscriptionNodes: verdict(persistedSubscriptionNodes, 500),
        soakReliability: soakReliabilityVerdict(
          soakResult,
          soakElapsedSeconds,
          soakSeconds,
          sqliteJournalMode,
        ),
      },
      raw: {
        directConnectP95Ms: Number(percentile(directSamples, 0.95).toFixed(3)),
        gatewayConnectP95Ms: Number(percentile(gatewaySamples, 0.95).toFixed(3)),
        soak: soakResult,
        soakElapsedSeconds,
        soakSeconds,
        sqliteJournalMode,
        subscriptionParseMs: Number(subscriptionParseMs.toFixed(3)),
      },
    };
    return result;
  } finally {
    await closeAll([
      ...(database ? [async () => database.close()] : []),
      ...(daemon ? [async () => daemon.close()] : []),
      ...listeners.map((listener) => async () => listener.close()),
      async () => rm(temporaryDirectory, { force: true, recursive: true }),
    ]);
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
