import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { startEgressd } from "./daemon.js";
import type { SessionBindingStore } from "./session.js";
import { openControlState } from "./state.js";
import { importLocalVlessYaml } from "./subscription.js";
import {
  ConnectionFaultPlan,
  connectTestTls,
  ManualClock,
  startHttpsTarget,
  startSimulatedMihomoListener,
  startTargetServer,
} from "./testing/harness.js";

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("/live reports Node process liveness without a Mihomo listener", async (t) => {
  const daemon = await startEgressd({ host: "127.0.0.1", port: 0 });
  t.after(() => daemon.close());

  const response = await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "live" });
});

test("console snapshot is authenticated and redacts management data", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-console-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const daemon = await startEgressd({
    adminToken: "console-admin",
    exitIpProbe: async () => ({
      city: "Tokyo",
      country: "JP",
      ip: "203.0.113.24",
      provider: "ipinfo",
      verifiedAt: 1_757_408_400_000,
    }),
    fetchSubscription: async () => new Response("proxies: []"),
    healthCheckJitterMs: 0,
    healthCheckProbe: async () => true,
    healthCheckUrls: [new URL("https://health.example/status")],
    host: "127.0.0.1",
    mihomoListener: new URL("http://127.0.0.1:20001"),
    port: 0,
    proxyAuthentication: false,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const origin = `http://${daemon.address.host}:${daemon.address.port}`;

  const unauthorized = await fetch(`${origin}/console/snapshot`);
  assert.equal(unauthorized.status, 401);

  const created = await fetch(`${origin}/subscriptions/remote`, {
    body: JSON.stringify({
      url: "https://user:password@provider.example/subscription?token=secret",
    }),
    headers: {
      authorization: "Bearer console-admin",
      "content-type": "application/json",
    },
    method: "POST",
  });
  assert.equal(created.status, 202);

  await new Promise((resolve) => setTimeout(resolve, 1_050));

  const response = await fetch(`${origin}/console/snapshot`, {
    headers: { authorization: "Bearer console-admin" },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    exitIps: Array<{ ip: string; location?: string; nodeCount: number }>;
    gateway: { host: string; port: number; ready: boolean };
    nodes: Array<{ exitIp?: string; exitLocation?: string; id: string; listener?: string }>;
    sessions: unknown[];
    subscriptions: Array<{ locator: string }>;
  };
  assert.deepEqual(body.gateway, {
    host: "127.0.0.1",
    port: daemon.address.port,
    ready: true,
  });
  assert.equal(body.nodes[0]?.id, "configured");
  assert.equal(body.nodes[0]?.exitIp, "203.0.113.24");
  assert.equal(body.nodes[0]?.exitLocation, "JP-Tokyo");
  assert.deepEqual(body.exitIps, [{ ip: "203.0.113.24", location: "JP-Tokyo", nodeCount: 1 }]);
  assert.equal(body.nodes[0]?.listener, undefined);
  assert.deepEqual(body.sessions, []);
  assert.equal(body.subscriptions.length, 1);
  assert.equal(body.subscriptions[0]?.locator, "https://provider.example/[redacted]");
  assert.doesNotMatch(JSON.stringify(body), /password|secret/);

  const verification = await fetch(`${origin}/nodes/configured/verify-exit`, {
    headers: { authorization: "Bearer console-admin" },
    method: "POST",
  });
  assert.equal(verification.status, 200);
  assert.deepEqual(await verification.json(), {
    city: "Tokyo",
    country: "JP",
    ip: "203.0.113.24",
    provider: "ipinfo",
    verifiedAt: 1_757_408_400_000,
  });
});

test("authenticated node enabled mutation controls scheduling health", async (t) => {
  const daemon = await startEgressd({
    adminToken: "console-admin",
    host: "127.0.0.1",
    mihomoListener: new URL("http://127.0.0.1:20001"),
    port: 0,
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());
  const origin = `http://${daemon.address.host}:${daemon.address.port}`;

  const response = await fetch(`${origin}/nodes/configured/enabled`, {
    body: JSON.stringify({ enabled: false }),
    headers: {
      authorization: "Bearer console-admin",
      "content-type": "application/json",
    },
    method: "PUT",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false, nodeId: "configured" });
  const snapshot = await fetch(`${origin}/console/snapshot`, {
    headers: { authorization: "Bearer console-admin" },
  });
  const body = (await snapshot.json()) as {
    gateway: { ready: boolean };
    nodeStatusCounts: Record<string, number>;
    nodes: Array<{ enabled: boolean; status: string }>;
  };
  assert.equal(body.gateway.ready, false);
  assert.equal(body.nodes[0]?.enabled, false);
  assert.equal(body.nodes[0]?.status, "disabled");
  assert.equal(body.nodeStatusCounts.disabled, 1);
  const readiness = await fetch(`${origin}/ready`);
  assert.equal(readiness.status, 503);
});

test("manual node enabled override survives a daemon restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-node-enabled-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const options = {
    adminToken: "console-admin",
    host: "127.0.0.1",
    mihomoListener: new URL("http://127.0.0.1:20001"),
    port: 0,
    proxyAuthentication: false as const,
    stateDirectory,
  };
  const first = await startEgressd(options);
  const firstOrigin = `http://${first.address.host}:${first.address.port}`;
  const disabled = await fetch(`${firstOrigin}/nodes/configured/enabled`, {
    body: JSON.stringify({ enabled: false }),
    headers: {
      authorization: "Bearer console-admin",
      "content-type": "application/json",
    },
    method: "PUT",
  });
  assert.equal(disabled.status, 200);
  await first.close();

  const restored = await startEgressd(options);
  t.after(() => restored.close());
  const restoredOrigin = `http://${restored.address.host}:${restored.address.port}`;
  const response = await fetch(`${restoredOrigin}/console/snapshot`, {
    headers: { authorization: "Bearer console-admin" },
  });
  const body = (await response.json()) as { nodes: Array<{ enabled: boolean; status: string }> };
  assert.equal(body.nodes[0]?.enabled, false);
  assert.equal(body.nodes[0]?.status, "disabled");
});

test("daemon shutdown closes an idle HTTP keep-alive connection", async () => {
  const daemon = await startEgressd({ host: "127.0.0.1", port: 0 });
  const client = connect(daemon.address.port, daemon.address.host);
  await once(client, "connect");
  client.write("GET /live HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
  await once(client, "data");
  const clientClosed = once(client, "close");

  await daemon.close();
  await clientClosed;
  assert.equal(client.destroyed, true);
});

test("daemon probes exits through their listeners and exposes manual health control", async (t) => {
  const targetRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(targetRequests);
  t.after(() => target.close());
  const listenerRequests: string[] = [];
  const mihomo = await startSimulatedMihomoListener(undefined, [], listenerRequests);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    healthCheckIntervalMs: 100,
    healthCheckJitterMs: 0,
    healthCheckUrls: [new URL(`http://${target.host}:${target.port}/health`)],
    host: "127.0.0.1",
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    port: 0,
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  await waitFor(async () => daemon.healthSnapshot()[0]?.status === "healthy");

  assert.deepEqual(listenerRequests, [`GET http://${target.host}:${target.port}/health`]);
  assert.equal(targetRequests.length, 1);
  assert.equal(daemon.setNodeEnabled("configured", false), true);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(daemon.healthSnapshot()[0]?.status, "disabled");
  assert.equal(targetRequests.length, 1);
});

test("daemon shutdown aborts and waits for an in-flight health probe", async () => {
  let started: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const daemon = await startEgressd({
    healthCheckIntervalMs: 1,
    healthCheckJitterMs: 0,
    healthCheckProbe: async (_listener, _target, signal) => {
      started?.();
      return new Promise<boolean>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
    },
    healthCheckUrls: [new URL("http://health.example")],
    host: "127.0.0.1",
    mihomoListener: new URL("http://127.0.0.1:20001"),
    port: 0,
    proxyAuthentication: false,
  });
  await probeStarted;

  await Promise.race([
    daemon.close(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("daemon shutdown did not cancel health probe")), 500),
    ),
  ]);
});

test("unauthenticated non-loopback proxy listeners require an explicit warned override", async (t) => {
  await assert.rejects(
    startEgressd({ host: "0.0.0.0", port: 0, proxyAuthentication: false }),
    /refusing to disable proxy authentication on a non-loopback host/,
  );

  const events: unknown[] = [];
  const daemon = await startEgressd({
    allowUnsafeUnauthenticatedProxy: true,
    host: "0.0.0.0",
    log: (event) => events.push(event),
    port: 0,
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  assert.deepEqual(events, [
    {
      event: "egressd.proxy_auth.disabled",
      exposure: "non-loopback",
      host: "0.0.0.0",
      level: "warn",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /token|authorization|secret/i);
});

test("egressd starts, imports local YAML, and shuts down on SIGTERM", async (t) => {
  const homeDirectory = await mkdtemp("/tmp/egresskit-cli-home-");
  t.after(() => rm(homeDirectory, { force: true, recursive: true }));
  const stateDirectory = join(homeDirectory, ".local", "state", "egresskit");
  const binaryDirectory = await mkdtemp(join(tmpdir(), "egresskit-cli-mihomo-"));
  t.after(() => rm(binaryDirectory, { force: true, recursive: true }));
  const binaryPath = join(binaryDirectory, "mihomo");
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(binaryPath, 0o700);
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const settingsState = await openControlState(stateDirectory);
  const settings = settingsState.loadRuntimeSettings("cli-admin-token");
  settingsState.updateRuntimeSettings({
    ...settings,
    host: "127.0.0.1",
    port: 0,
    mihomoHttpListener: `http://${mihomo.host}:${mihomo.port}`,
  });
  await settingsState.close();
  const child = spawn(process.execPath, ["dist/cli.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      EGRESSKIT_ADMIN_TOKEN: "cli-admin-token",
      HOME: homeDirectory,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

  try {
    const line = await new Promise<Buffer>((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `egressd exited before startup (code=${code}, signal=${signal}): ${Buffer.concat(errors).toString()}`,
          ),
        );
      });
    });
    const started = JSON.parse(line.toString()) as {
      event: string;
      host: string;
      port: number;
    };

    assert.equal(started.event, "egressd.started");
    assert.equal(started.host, "127.0.0.1");
    assert.ok(started.port > 0);

    const response = await fetch(`http://${started.host}:${started.port}/live`);
    assert.equal(response.status, 200);

    const imported = await fetch(`http://${started.host}:${started.port}/subscriptions/local`, {
      method: "POST",
      headers: { authorization: "Bearer cli-admin-token" },
      body: `proxies:
  - { name: cli-node, type: vless, server: proxy.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
    });
    assert.equal(imported.status, 201);
    assert.doesNotMatch(await imported.text(), /11111111-1111-4111-8111-111111111111/);

    child.kill("SIGTERM");
    const [exitCode, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(signal, null);
    assert.equal(exitCode, 0, Buffer.concat(errors).toString());
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test("an HTTP proxy request reaches the target through the simulated Mihomo listener", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  const targetUrl = `http://${target.host}:${target.port}/observed?through=egresskit`;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const proxyRequest = request(
      {
        host: daemon.address.host,
        method: "GET",
        path: targetUrl,
        port: daemon.address.port,
      },
      (proxyResponse) => {
        const chunks: Buffer[] = [];
        proxyResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyResponse.on("end", () =>
          resolve({
            status: proxyResponse.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });

  assert.equal(response.status, 200);
  assert.equal(observedRequests.length, 1);
  assert.deepEqual(JSON.parse(response.body), observedRequests[0]);
  assert.equal(observedRequests[0]?.url, "/observed?through=egresskit");
  assert.equal(observedRequests[0]?.headers.via, "1.1 egresskit, 1.1 simulated-mihomo");
});

test("a restart restores the last valid revision and forwards without reimporting its source", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-daemon-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const appliedConfigs: unknown[] = [];
  const options = {
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false as const,
    stateDirectory,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async (
        config: Parameters<
          NonNullable<Parameters<typeof startEgressd>[0]["mihomoRuntime"]>["apply"]
        >[0],
      ) => {
        appliedConfigs.push(config);
        return new Map([["primary", new URL(`http://${mihomo.host}:${mihomo.port}`)]]);
      },
    },
  };
  const first = await startEgressd(options);
  const imported = await fetch(
    `http://${first.address.host}:${first.address.port}/subscriptions/local`,
    {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
      body: `proxies:
  - { name: primary, type: vless, server: proxy.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
    },
  );
  assert.equal(imported.status, 201);
  await first.close();

  const restored = await startEgressd(options);
  t.after(() => restored.close());
  const response = await sendProxyRequestResponse(
    restored.address,
    `http://${target.host}:${target.port}/restored`,
    "GET",
    "",
  );

  assert.equal(response.status, 200);
  assert.equal(observedRequests[0]?.url, "/restored");
  assert.equal(appliedConfigs.length, 2);
  assert.deepEqual(appliedConfigs[1], appliedConfigs[0]);
});

test("an unavailable remote source does not block startup from its last valid snapshot", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-daemon-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const sourceUrl = "https://127.0.0.1:1/subscription.yaml";
  const imported = importLocalVlessYaml(
    `proxies:
  - { name: remote, type: vless, server: proxy.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
    { firstListenerPort: 20_000 },
  );
  const state = await openControlState(stateDirectory);
  state.saveActiveRevision({
    imported,
    source: { id: "remote-subscription", kind: "remote", locator: sourceUrl },
  });
  await state.close();

  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    stateDirectory,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () => new Map([["remote", new URL(`http://${mihomo.host}:${mihomo.port}`)]]),
    },
  });
  t.after(() => daemon.close());

  const response = await sendProxyRequestResponse(
    daemon.address,
    `http://${target.host}:${target.port}/offline-restore`,
    "GET",
    "",
  );
  assert.equal(response.status, 200);
  assert.equal(observedRequests[0]?.url, "/offline-restore");
  await daemon.close();
  const reopenedState = await openControlState(stateDirectory);
  assert.deepEqual(reopenedState.loadActiveRevision()?.source, {
    id: "remote-subscription",
    kind: "remote",
    locator: sourceUrl,
  });
  await reopenedState.close();
});

test("startup closes its Mihomo runtime when a restored revision cannot become ready", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-startup-cleanup-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const imported = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: primary.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  const state = await openControlState(stateDirectory);
  state.saveActiveRevision({
    imported,
    source: { id: "local", kind: "local", locator: "inline" },
  });
  await state.close();
  let closeCalls = 0;

  await assert.rejects(
    startEgressd({
      checkMihomoListener: async () => {
        throw new Error("listener never became ready");
      },
      host: "127.0.0.1",
      mihomoRuntime: {
        apply: async () => new Map([["primary", new URL("http://127.0.0.1:20000")]]),
        check: async () => undefined,
        close: async () => {
          closeCalls += 1;
        },
        removeListener: async () => undefined,
      },
      port: 0,
      proxyAuthentication: false,
      stateDirectory,
    }),
    /listener never became ready/,
  );
  assert.equal(closeCalls, 1);
});

test("a second daemon cannot own the same state directory", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-daemon-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const first = await startEgressd({ host: "127.0.0.1", port: 0, stateDirectory });
  t.after(() => first.close());

  await assert.rejects(
    startEgressd({ host: "127.0.0.1", port: 0, stateDirectory }),
    /already owned by another daemon/,
  );
});

test("an invalid remote timeout does not retain the state directory lock", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-daemon-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));

  await assert.rejects(
    startEgressd({
      host: "127.0.0.1",
      port: 0,
      remoteSubscriptionTimeoutMs: 0,
      stateDirectory,
    }),
    /remote subscription fetch timeout must be positive/,
  );

  const retried = await startEgressd({ host: "127.0.0.1", port: 0, stateDirectory });
  await retried.close();
});

test("HTTP proxy requests require valid standard Basic proxy credentials", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const observedListenerRequests: string[] = [];
  const mihomo = await startSimulatedMihomoListener(undefined, [], observedListenerRequests);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: { tokens: ["proxy-secret"] },
  });
  t.after(() => daemon.close());
  const targetUrl = `http://${target.host}:${target.port}/authenticated`;

  for (const proxyAuthorization of [
    undefined,
    "Bearer proxy-secret",
    "Basic not-base64!",
    basicProxyAuthorization("unknown", "proxy-secret"),
    basicProxyAuthorization("rotate", "wrong-secret"),
  ]) {
    const response = await sendProxyRequestResponse(
      daemon.address,
      targetUrl,
      "GET",
      "",
      proxyAuthorization === undefined ? {} : { "proxy-authorization": proxyAuthorization },
    );

    assert.equal(response.status, 407);
    assert.equal(response.headers["proxy-authenticate"], 'Basic realm="EgressKit"');
  }

  const accepted = await sendProxyRequestResponse(daemon.address, targetUrl, "GET", "", {
    "proxy-authorization": basicProxyAuthorization("rotate", "proxy-secret"),
  });
  assert.equal(accepted.status, 200);
  assert.equal(observedListenerRequests.length, 1);
  assert.equal(observedRequests.length, 1);
  assert.ok(
    observedRequests.every((request) => request.headers["proxy-authorization"] === undefined),
  );
});

test("each new HTTP proxy request performs a fresh rotate selection", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const { daemon } = await startTwoExitDaemon(
    t,
    new Map([
      [
        "local:first",
        {
          activeConnections: 0,
          consecutiveFailures: 0,
          ewmaLatencyMs: 10,
          healthy: true,
          manualWeight: 2,
          successRate: 1,
        },
      ],
      [
        "local:second",
        {
          activeConnections: 1,
          consecutiveFailures: 1,
          ewmaLatencyMs: 20,
          healthy: true,
          manualWeight: 4,
          successRate: 0.75,
        },
      ],
    ]),
  );

  for (let requestNumber = 1; requestNumber <= 4; requestNumber += 1) {
    assert.equal(
      await sendProxyRequest(
        daemon.address,
        `http://${target.host}:${target.port}/request-${requestNumber}`,
        "GET",
        "",
      ),
      200,
    );
  }

  assert.deepEqual(
    observedRequests.map((request) => request.headers["x-egresskit-test-exit"]),
    ["first", "second", "first", "second"],
  );
});

test("GET, HEAD, and POST are forwarded once with their original method and body", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  for (const [method, body] of [
    ["GET", ""],
    ["HEAD", ""],
    ["POST", "payload"],
  ] as const) {
    await sendProxyRequest(
      daemon.address,
      `http://${target.host}:${target.port}/${method.toLowerCase()}`,
      method,
      body,
    );
  }

  assert.deepEqual(
    observedRequests.map(({ method, body }) => ({ method, body })),
    [
      { method: "GET", body: "" },
      { method: "HEAD", body: "" },
      { method: "POST", body: "payload" },
    ],
  );
});

test("sent GET, HEAD, and POST requests are not replayed to another listener", {
  timeout: 2_000,
}, async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests, { closeWithoutResponse: true });
  t.after(() => target.close());
  const firstListenerRequests: string[] = [];
  const first = await startSimulatedMihomoListener(undefined, [], firstListenerRequests);
  t.after(() => first.close());
  const secondListenerRequests: string[] = [];
  const second = await startSimulatedMihomoListener(undefined, [], secondListenerRequests);
  t.after(() => second.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${first.host}:${first.port}`)],
          ["second", new URL(`http://${second.host}:${second.port}`)],
        ]),
    },
  });
  t.after(() => daemon.close());
  const imported = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
      body: `proxies:
  - { name: first, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
    },
  );
  assert.equal(imported.status, 201);
  for (const [method, body] of [
    ["GET", ""],
    ["HEAD", ""],
    ["POST", "do-not-replay"],
  ] as const) {
    assert.equal(
      await sendProxyRequest(
        daemon.address,
        `http://${target.host}:${target.port}/failed`,
        method,
        body,
      ),
      502,
    );
  }

  assert.deepEqual(
    observedRequests.map(({ method, body }) => ({ method, body })),
    [
      { method: "GET", body: "" },
      { method: "HEAD", body: "" },
      { method: "POST", body: "do-not-replay" },
    ],
  );
  assert.deepEqual([...firstListenerRequests, ...secondListenerRequests].sort(), [
    `GET http://${target.host}:${target.port}/failed`,
    `HEAD http://${target.host}:${target.port}/failed`,
    `POST http://${target.host}:${target.port}/failed`,
  ]);
});

test("soft sticky retries a different listener before sending HTTP and keeps the successful binding", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-http-failover-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const unavailable = await startSimulatedMihomoListener();
  await unavailable.close();
  const secondRequests: string[] = [];
  const second = await startSimulatedMihomoListener(undefined, [], secondRequests, "second");
  t.after(() => second.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    checkMihomoListener: async () => undefined,
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["proxy-secret"] },
    stateDirectory,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${unavailable.host}:${unavailable.port}`)],
          ["second", new URL(`http://${second.host}:${second.port}`)],
        ]),
    },
  });
  t.after(() => daemon.close());
  assert.equal(await importLocalNodes(daemon.address, ["first", "second"]), 201);
  const headers = {
    "proxy-authorization": basicProxyAuthorization("sticky.preconnect", "proxy-secret"),
  };
  const targetUrl = `http://${target.host}:${target.port}/preconnect`;

  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "POST", "once", headers), 200);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", "", headers), 200);
  assert.deepEqual(secondRequests, [`POST ${targetUrl}`, `GET ${targetUrl}`]);
  assert.deepEqual(
    observedRequests.map(({ body }) => body),
    ["once", ""],
  );
});

test("HTTP listener transport failure is recorded without replay and egressd stays live", async (t) => {
  const outcomes: unknown[] = [];
  const resetting = await startResettingHttpListener();
  t.after(() => resetting.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    checkMihomoListener: async () => undefined,
    host: "127.0.0.1",
    onConnectionOutcome: (outcome) => outcomes.push(outcome),
    port: 0,
    proxyAuthentication: false,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([["first", new URL(`http://${resetting.host}:${resetting.port}`)]]),
    },
  });
  t.after(() => daemon.close());
  assert.equal(await importLocalNodes(daemon.address, ["first"]), 201);

  assert.equal(
    await sendProxyRequest(daemon.address, "http://target.example/never-replay", "POST", "once"),
    502,
  );
  assert.equal(resetting.requests, 1);
  assert.deepEqual(outcomes, [{ nodeId: "local:first", result: "failure" }]);
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`)).status,
    200,
  );
});

test("rotate retries a different listener before CONNECT 200", { timeout: 2_000 }, async (t) => {
  const target = await startHttpsTarget([]);
  t.after(() => target.close());
  const faults = new ConnectionFaultPlan();
  faults.failNext("before-target-connect");
  const unavailable = await startSimulatedMihomoListener(faults);
  t.after(() => unavailable.close());
  const secondSelections: string[] = [];
  const second = await startSimulatedMihomoListener(undefined, secondSelections);
  t.after(() => second.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    checkMihomoListener: async () => undefined,
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${unavailable.host}:${unavailable.port}`)],
          ["second", new URL(`http://${second.host}:${second.port}`)],
        ]),
    },
  });
  t.after(() => daemon.close());
  assert.equal(await importLocalNodes(daemon.address, ["first", "second"]), 201);
  const authority = `${target.host}:${target.port}`;

  assert.match(
    await sendConnectRequest(daemon.address, authority),
    /^HTTP\/1\.1 200 Connection Established/,
  );
  assert.deepEqual(secondSelections, [authority]);
  const metrics = await fetch(`http://${daemon.address.host}:${daemon.address.port}/metrics`, {
    headers: { authorization: "Bearer test-admin-token" },
  });
  const metricsBody = await metrics.text();
  assert.match(metricsBody, /egresskit_connection_failures_total 1/);
  assert.match(metricsBody, /egresskit_fallbacks_total 1/);
});

test("CONNECT failover uses three attempts by default and honors a bounded override", async (t) => {
  const target = await startHttpsTarget([]);
  t.after(() => target.close());
  const faultPlans = Array.from({ length: 3 }, () => {
    const plan = new ConnectionFaultPlan();
    plan.failNext("before-target-connect");
    plan.failNext("before-target-connect");
    return plan;
  });
  const failedListeners = await Promise.all(
    faultPlans.map((plan) => startSimulatedMihomoListener(plan)),
  );
  for (const listener of failedListeners) {
    t.after(() => listener.close());
  }
  const fourthSelections: string[] = [];
  const fourth = await startSimulatedMihomoListener(undefined, fourthSelections);
  t.after(() => fourth.close());
  const listeners = new Map([
    ["one", new URL(`http://${failedListeners[0]?.host}:${failedListeners[0]?.port}`)],
    ["two", new URL(`http://${failedListeners[1]?.host}:${failedListeners[1]?.port}`)],
    ["three", new URL(`http://${failedListeners[2]?.host}:${failedListeners[2]?.port}`)],
    ["four", new URL(`http://${fourth.host}:${fourth.port}`)],
  ]);
  const startDaemon = (preconnectAttempts?: number) =>
    startEgressd({
      adminToken: "test-admin-token",
      host: "127.0.0.1",
      port: 0,
      ...(preconnectAttempts === undefined ? {} : { preconnectAttempts }),
      proxyAuthentication: false,
      mihomoRuntime: {
        apply: async () => listeners,
        check: async () => undefined,
        removeListener: async () => undefined,
      },
    });
  const source = `proxies:
  - { name: one, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: two, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
  - { name: three, type: vless, server: three.example.com, port: 443, uuid: 33333333-3333-4333-8333-333333333333 }
  - { name: four, type: vless, server: four.example.com, port: 443, uuid: 44444444-4444-4444-8444-444444444444 }
`;
  const authority = `${target.host}:${target.port}`;

  const defaultDaemon = await startDaemon();
  assert.equal((await defaultDaemon.importLocalSubscription(source)).nodes.length, 4);
  assert.match(await sendConnectRequest(defaultDaemon.address, authority), /^HTTP\/1\.1 502/);
  assert.deepEqual(fourthSelections, []);
  await defaultDaemon.close();

  const configuredDaemon = await startDaemon(4);
  t.after(() => configuredDaemon.close());
  assert.equal((await configuredDaemon.importLocalSubscription(source)).nodes.length, 4);
  assert.match(
    await sendConnectRequest(configuredDaemon.address, authority),
    /^HTTP\/1\.1 200 Connection Established/,
  );
  assert.deepEqual(fourthSelections, [authority]);

  await assert.rejects(startDaemon(11), /between 1 and 10/);
});

test("strict sticky and explicit node routes never use another candidate", async (t) => {
  const faults = new ConnectionFaultPlan();
  faults.failNext("before-target-connect");
  faults.failNext("before-target-connect");
  const first = await startSimulatedMihomoListener(faults);
  t.after(() => first.close());
  const secondSelections: string[] = [];
  const second = await startSimulatedMihomoListener(undefined, secondSelections);
  t.after(() => second.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["proxy-secret"] },
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${first.host}:${first.port}`)],
          ["second", new URL(`http://${second.host}:${second.port}`)],
        ]),
    },
  });
  t.after(() => daemon.close());
  assert.equal(await importLocalNodes(daemon.address, ["first", "second"]), 201);

  assert.match(
    await sendConnectRequest(
      daemon.address,
      "strict.example:443",
      basicProxyAuthorization("strict.no-fallback", "proxy-secret"),
    ),
    /^HTTP\/1\.1 502/,
  );
  assert.match(
    await sendConnectRequest(
      daemon.address,
      "node.example:443",
      basicProxyAuthorization("node.local%3Afirst", "proxy-secret"),
    ),
    /^HTTP\/1\.1 502/,
  );
  assert.deepEqual(secondSelections, []);
});

test("CONNECT timeout retries, while client cancellation stops without trying another node", async (t) => {
  const target = await startHttpsTarget([]);
  t.after(() => target.close());
  let timeoutConnections = 0;
  const timeoutListener = await startHangingTcpListener(() => {
    timeoutConnections += 1;
  });
  t.after(() => timeoutListener.close());
  const timeoutFallbackSelections: string[] = [];
  const timeoutOutcomes: unknown[] = [];
  const timeoutFallback = await startSimulatedMihomoListener(undefined, timeoutFallbackSelections);
  t.after(() => timeoutFallback.close());
  const timeoutDaemon = await startEgressd({
    adminToken: "test-admin-token",
    checkMihomoListener: async () => undefined,
    host: "127.0.0.1",
    onConnectionOutcome: (outcome) => timeoutOutcomes.push(outcome),
    port: 0,
    preconnectTimeoutMs: 20,
    proxyAuthentication: false,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${timeoutListener.host}:${timeoutListener.port}`)],
          ["second", new URL(`http://${timeoutFallback.host}:${timeoutFallback.port}`)],
        ]),
    },
  });
  t.after(() => timeoutDaemon.close());
  assert.equal(await importLocalNodes(timeoutDaemon.address, ["first", "second"]), 201);
  assert.match(
    await sendConnectRequest(timeoutDaemon.address, `${target.host}:${target.port}`),
    /^HTTP\/1\.1 200 Connection Established/,
  );
  assert.equal(timeoutConnections, 1);
  assert.deepEqual(timeoutFallbackSelections, [`${target.host}:${target.port}`]);
  assert.deepEqual(
    timeoutOutcomes.map((outcome) => (outcome as { result: string }).result),
    ["failure", "success"],
  );
  await timeoutDaemon.close();

  let cancelledConnections = 0;
  const cancelledListener = await startHangingTcpListener(() => {
    cancelledConnections += 1;
  });
  t.after(() => cancelledListener.close());
  const cancellationFallbackSelections: string[] = [];
  const cancellationOutcomes: unknown[] = [];
  const cancellationFallback = await startSimulatedMihomoListener(
    undefined,
    cancellationFallbackSelections,
  );
  t.after(() => cancellationFallback.close());
  const cancellationDaemon = await startEgressd({
    adminToken: "test-admin-token",
    checkMihomoListener: async () => undefined,
    host: "127.0.0.1",
    onConnectionOutcome: (outcome) => cancellationOutcomes.push(outcome),
    port: 0,
    preconnectTimeoutMs: 100,
    proxyAuthentication: false,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${cancelledListener.host}:${cancelledListener.port}`)],
          ["second", new URL(`http://${cancellationFallback.host}:${cancellationFallback.port}`)],
        ]),
    },
  });
  t.after(() => cancellationDaemon.close());
  assert.equal(await importLocalNodes(cancellationDaemon.address, ["first", "second"]), 201);

  const cancelled = connect(cancellationDaemon.address.port, cancellationDaemon.address.host);
  await once(cancelled, "connect");
  cancelled.write("CONNECT cancel.example:443 HTTP/1.1\r\nHost: cancel.example:443\r\n\r\n");
  while (cancelledConnections < 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await new Promise<void>((resolve) => {
    cancelled.once("close", () => resolve());
    cancelled.destroy();
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(cancelledConnections, 1);
  assert.deepEqual(cancellationFallbackSelections, []);
  assert.deepEqual(cancellationOutcomes, []);
});

test("an upstream failure after CONNECT 200 only closes the tunnel", {
  timeout: 2_000,
}, async (t) => {
  const connectionEvents: string[] = [];
  const target = await startHttpsTarget([], connectionEvents);
  t.after(() => target.close());
  const faults = new ConnectionFaultPlan();
  faults.failNext("after-tunnel-established");
  const mihomo = await startSimulatedMihomoListener(faults);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  const targetAuthority = `${target.host}:${target.port}`;
  const received = await new Promise<string>((resolve, reject) => {
    const socket = connect(daemon.address.port, daemon.address.host);
    let response = "";
    socket.on("connect", () =>
      socket.write(`CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n\r\n`),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });

  assert.equal(received, "HTTP/1.1 200 Connection Established\r\n\r\n");
  assert.deepEqual(connectionEvents, ["opened", "closed"]);
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`)).status,
    200,
  );
});

test("daemon shutdown closes an established CONNECT tunnel before reporting completion", {
  timeout: 3_000,
}, async (t) => {
  const target = await startHttpsTarget([]);
  t.after(() => target.close());
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: false,
  });

  const client = connect(daemon.address.port, daemon.address.host);
  await once(client, "connect");
  client.write(
    `CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`,
  );
  await once(client, "data");
  const clientClosed = once(client, "close");

  await daemon.close();
  await clientClosed;
  assert.equal(client.destroyed, true);
});

test("CONNECT requires the same standard Basic proxy credentials", {
  timeout: 2_000,
}, async (t) => {
  const target = await startHttpsTarget([]);
  t.after(() => target.close());
  const observedConnectTargets: string[] = [];
  const mihomo = await startSimulatedMihomoListener(undefined, observedConnectTargets);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: { tokens: ["proxy-secret"] },
  });
  t.after(() => daemon.close());
  const authority = `${target.host}:${target.port}`;

  for (const proxyAuthorization of [
    undefined,
    "Basic not-base64!",
    basicProxyAuthorization("rotate", "wrong-secret"),
  ]) {
    const response = await sendConnectRequest(daemon.address, authority, proxyAuthorization);
    assert.match(response, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/i);
    assert.match(response, /Proxy-Authenticate: Basic realm="EgressKit"\r\n/i);
  }
  assert.equal(observedConnectTargets.length, 0);

  const accepted = await sendConnectRequest(
    daemon.address,
    authority,
    basicProxyAuthorization("rotate", "proxy-secret"),
  );
  assert.match(accepted, /^HTTP\/1\.1 200 Connection Established\r\n/);
  assert.deepEqual(observedConnectTargets, [authority]);
});

test("new CONNECT tunnels rotate while requests inside one tunnel keep the same exit", {
  timeout: 2_000,
}, async (t) => {
  const receivedRequests: string[] = [];
  const target = await startHttpsTarget(receivedRequests);
  t.after(() => target.close());
  const { daemon, firstSelections, secondSelections } = await startTwoExitDaemon(t);
  const authority = `${target.host}:${target.port}`;

  await sendHttpsPayloadThroughProxy(
    daemon.address,
    authority,
    `GET /one HTTP/1.1\r\nHost: ${authority}\r\n\r\nGET /two HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
  );
  await sendHttpsPayloadThroughProxy(
    daemon.address,
    authority,
    `GET /three HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
  );

  assert.deepEqual(firstSelections, [authority]);
  assert.deepEqual(secondSelections, [authority]);
  const received = receivedRequests.join("");
  assert.match(received, /GET \/one HTTP\/1\.1/);
  assert.match(received, /GET \/two HTTP\/1\.1/);
  assert.match(received, /GET \/three HTTP\/1\.1/);
});

test("concurrent first soft-sticky requests share one binding and obey the connection cap", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-sticky-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  let releaseResponses = (): void => undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  const target = await startTargetServer(observedRequests, {
    beforeResponse: () => responseGate,
  });
  t.after(() => target.close());
  const { daemon } = await startTwoExitDaemon(t, undefined, {
    proxyAuthentication: { tokens: ["proxy-secret"] },
    sessionMaximumConcurrentConnections: 2,
    stateDirectory,
  });
  const headers = {
    "proxy-authorization": basicProxyAuthorization("sticky.shared-session", "proxy-secret"),
  };
  const targetUrl = `http://${target.host}:${target.port}/sticky`;

  const first = sendProxyRequestResponse(daemon.address, targetUrl, "GET", "", headers);
  const second = sendProxyRequestResponse(daemon.address, targetUrl, "GET", "", headers);
  await Promise.race([
    (async () => {
      while (observedRequests.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    })(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("sticky requests did not reach one bound exit")), 250),
    ),
  ]);
  const rejected = await sendProxyRequestResponse(daemon.address, targetUrl, "GET", "", headers);
  assert.equal(rejected.status, 429);
  releaseResponses();
  assert.deepEqual(
    (await Promise.all([first, second])).map(({ status }) => status),
    [200, 200],
  );
  assert.deepEqual(
    observedRequests.map((entry) => entry.headers["x-egresskit-test-exit"]),
    ["first", "first"],
  );
});

test("session persistence failures return a controlled proxy error without stopping egressd", async (t) => {
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const failingStore: SessionBindingStore = {
    countSessionBindings: () => 0,
    deleteExpiredSessionBindings: () => {
      throw new Error("injected session storage failure");
    },
    getSessionBinding: () => undefined,
    loadOrCreateSessionHmacKey: () => Buffer.alloc(32, 1),
    saveSessionBinding: () => undefined,
    touchSessionBinding: () => undefined,
  };
  const daemon = await startEgressd({
    host: "127.0.0.1",
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    port: 0,
    proxyAuthentication: { tokens: ["proxy-secret"] },
    sessionBindingStore: failingStore,
  });
  t.after(() => daemon.close());
  const authorization = basicProxyAuthorization("sticky.storage-failure", "proxy-secret");

  const response = await sendProxyRequestResponse(
    daemon.address,
    "http://example.test/unavailable",
    "GET",
    "",
    { "proxy-authorization": authorization },
  );
  assert.equal(response.status, 503);
  assert.match(
    await sendConnectRequest(daemon.address, "example.test:443", authorization),
    /^HTTP\/1\.1 503 Service Unavailable/,
  );
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`)).status,
    200,
  );
});

test("soft sticky rebinds new connections without migrating an existing tunnel", {
  timeout: 2_000,
}, async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-sticky-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const targetConnections: string[] = [];
  const target = await startHttpsTarget([], targetConnections);
  t.after(() => target.close());
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const httpTarget = await startTargetServer(observedRequests);
  t.after(() => httpTarget.close());
  const { daemon, firstSelections, secondSelections } = await startTwoExitDaemon(t, undefined, {
    proxyAuthentication: { tokens: ["proxy-secret"] },
    stateDirectory,
  });
  const authorization = basicProxyAuthorization("sticky.failover-session", "proxy-secret");
  const tunnel = await openConnectTunnel(
    daemon.address,
    `${target.host}:${target.port}`,
    authorization,
  );
  t.after(() => tunnel.destroy());
  assert.deepEqual(firstSelections, [`${target.host}:${target.port}`]);

  const imported = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
      body: `proxies:
  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
    },
  );
  assert.equal(imported.status, 201);
  assert.equal(tunnel.destroyed, false);
  assert.deepEqual(targetConnections, ["opened"]);

  const response = await sendProxyRequestResponse(
    daemon.address,
    `http://${httpTarget.host}:${httpTarget.port}/rebound`,
    "GET",
    "",
    { "proxy-authorization": authorization },
  );
  assert.equal(response.status, 200);
  assert.equal(observedRequests[0]?.headers["x-egresskit-test-exit"], "second");
  assert.equal(firstSelections.length, 1);
  assert.equal(secondSelections.length, 0);
  assert.equal(tunnel.destroyed, false);
  tunnel.destroy();
  await once(tunnel, "close");
});

test("soft sticky persists only an HMAC identity and expires absolute and idle sessions", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-sticky-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const clock = new ManualClock(10_000);
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const { daemon } = await startTwoExitDaemon(t, undefined, {
    proxyAuthentication: { tokens: ["proxy-secret"] },
    sessionAbsoluteTtlMs: 1_000,
    sessionClock: clock,
    sessionIdleTimeoutMs: 500,
    sessionMaximumActiveSessions: 1,
    stateDirectory,
  });
  const targetUrl = `http://${target.host}:${target.port}/limits`;

  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("sticky.secret-session", "proxy-secret"),
    }),
    200,
  );
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("sticky.other-session", "proxy-secret"),
    }),
    429,
  );
  clock.advanceBy(501);
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("sticky.other-session", "proxy-secret"),
    }),
    200,
  );
  clock.advanceBy(400);
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("sticky.other-session", "proxy-secret"),
    }),
    200,
  );
  clock.advanceBy(400);
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("sticky.other-session", "proxy-secret"),
    }),
    200,
  );
  clock.advanceBy(201);
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("sticky.secret-session", "proxy-secret"),
    }),
    200,
  );

  await daemon.close();
  const state = await openControlState(stateDirectory);
  const identity = createHmac("sha256", state.loadOrCreateSessionHmacKey())
    .update("secret-session")
    .digest("hex");
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(state.getSessionBinding(identity)?.logicalNodeId, "local:first");
  await state.close();
  const database = await readFile(join(stateDirectory, "control.sqlite"));
  assert.equal(database.includes(Buffer.from("secret-session")), false);
  assert.equal(database.includes(Buffer.from("other-session")), false);
});

test("strict sticky fails on a missing bound node, preserves it, and isolates new session keys", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-strict-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const { daemon, secondSelections } = await startTwoExitDaemon(t, undefined, {
    proxyAuthentication: { tokens: ["proxy-secret"] },
    stateDirectory,
  });
  const targetUrl = `http://${target.host}:${target.port}/strict`;
  const strictA = {
    "proxy-authorization": basicProxyAuthorization("strict.session-a", "proxy-secret"),
  };
  const strictB = {
    "proxy-authorization": basicProxyAuthorization("strict.session-b", "proxy-secret"),
  };

  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", "", strictA), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");
  assert.equal(await importLocalNodes(daemon.address, ["second"]), 201);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", "", strictA), 502);
  const tunnelTarget = await startHttpsTarget([]);
  t.after(() => tunnelTarget.close());
  assert.match(
    await sendConnectRequest(
      daemon.address,
      `${tunnelTarget.host}:${tunnelTarget.port}`,
      strictA["proxy-authorization"],
    ),
    /^HTTP\/1\.1 502 Bad Gateway/,
  );
  assert.deepEqual(secondSelections, []);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", "", strictB), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "second");

  assert.equal(await importLocalNodes(daemon.address, ["first"]), 201);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", "", strictA), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");
});

test("explicit node ID and alias routing is deterministic and never mutates sticky bindings", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-node-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const { daemon, secondSelections } = await startTwoExitDaemon(t, undefined, {
    proxyAuthentication: { tokens: ["proxy-secret"] },
    stateDirectory,
  });
  const targetUrl = `http://${target.host}:${target.port}/selected`;
  const requestThrough = (username: string) =>
    sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization(username, "proxy-secret"),
    });

  assert.equal(await requestThrough("sticky.session-a"), 200);
  assert.equal(await requestThrough("node.second"), 502);
  assert.equal(await setNodeAlias(daemon.address, "local:first", "primary"), 200);
  assert.equal(await setNodeAlias(daemon.address, "local:second", "primary"), 409);
  assert.equal(await setNodeAlias(daemon.address, "local:second", "backup"), 200);
  assert.equal(await requestThrough("node.backup"), 200);
  assert.equal(await requestThrough("sticky.session-a"), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");
  assert.equal(await requestThrough("node.local%3Afirst"), 200);
  assert.deepEqual(
    observedRequests.map((entry) => entry.headers["x-egresskit-test-exit"]),
    ["first", "second", "first", "first"],
  );
  const tunnelTarget = await startHttpsTarget([]);
  t.after(() => tunnelTarget.close());
  const authority = `${tunnelTarget.host}:${tunnelTarget.port}`;
  assert.match(
    await sendConnectRequest(
      daemon.address,
      authority,
      basicProxyAuthorization("node.backup", "proxy-secret"),
    ),
    /^HTTP\/1\.1 200 Connection Established/,
  );
  assert.deepEqual(secondSelections, [authority]);
  assert.equal(await requestThrough("sticky.session-a"), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");

  assert.equal(await importLocalNodes(daemon.address, ["first"]), 201);
  assert.equal(await requestThrough("node.backup"), 502);
  assert.match(
    await sendConnectRequest(
      daemon.address,
      authority,
      basicProxyAuthorization("node.backup", "proxy-secret"),
    ),
    /^HTTP\/1\.1 502 Bad Gateway/,
  );
  assert.deepEqual(secondSelections, [authority]);
  assert.equal(await requestThrough("sticky.session-a"), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");
});

test("alias updates serialize with revision activation and remain routable", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-alias-race-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const first = await startSimulatedMihomoListener(undefined, [], [], "first");
  t.after(() => first.close());
  const second = await startSimulatedMihomoListener(undefined, [], [], "second");
  t.after(() => second.close());
  let releaseSecondApply: (() => void) | undefined;
  let notifySecondApply: (() => void) | undefined;
  const secondApplyStarted = new Promise<void>((resolve) => {
    notifySecondApply = resolve;
  });
  const secondApplyReleased = new Promise<void>((resolve) => {
    releaseSecondApply = resolve;
  });
  let applyCount = 0;
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["proxy-secret"] },
    stateDirectory,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () => {
        applyCount += 1;
        if (applyCount === 2) {
          notifySecondApply?.();
          await secondApplyReleased;
        }
        return new Map([
          ["first", new URL(`http://${first.host}:${first.port}`)],
          ["second", new URL(`http://${second.host}:${second.port}`)],
        ]);
      },
    },
  });
  t.after(() => daemon.close());
  assert.equal(await importLocalNodes(daemon.address, ["first"]), 201);

  const importing = importLocalNodes(daemon.address, ["first", "second"]);
  await secondApplyStarted;
  const aliasing = setNodeAlias(daemon.address, "local:first", "primary");
  let aliasSettled = false;
  void aliasing.then(
    () => {
      aliasSettled = true;
    },
    () => {
      aliasSettled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const aliasSettledBeforeRelease = aliasSettled;
  releaseSecondApply?.();

  assert.equal(aliasSettledBeforeRelease, false);
  assert.equal(await importing, 201);
  assert.equal(await aliasing, 200);
  assert.equal(
    await sendProxyRequest(
      daemon.address,
      `http://${target.host}:${target.port}/serialized-alias`,
      "GET",
      "",
      {
        "proxy-authorization": basicProxyAuthorization("node.primary", "proxy-secret"),
      },
    ),
    200,
  );
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");
});

test("alias conflicts are rejected before runtime apply and preserve the active exit", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-alias-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const first = await startSimulatedMihomoListener(undefined, [], [], "first");
  t.after(() => first.close());
  let applyCount = 0;
  const options = {
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["proxy-secret"] } as const,
    stateDirectory,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () => {
        applyCount += 1;
        return new Map([["first", new URL(`http://${first.host}:${first.port}`)]]);
      },
    },
  };
  const daemon = await startEgressd(options);
  t.after(() => daemon.close());
  assert.equal(await importLocalNodes(daemon.address, ["first"]), 201);
  assert.equal(await setNodeAlias(daemon.address, "local:first", "local:second"), 200);

  assert.equal(await importLocalNodes(daemon.address, ["second"]), 422);
  assert.equal(applyCount, 1);
  assert.equal(
    await sendProxyRequest(
      daemon.address,
      `http://${target.host}:${target.port}/preserved`,
      "GET",
      "",
      {
        "proxy-authorization": basicProxyAuthorization("node.local%3Asecond", "proxy-secret"),
      },
    ),
    200,
  );
  assert.equal(observedRequests[0]?.headers["x-egresskit-test-exit"], "first");

  await daemon.close();
  const restarted = await startEgressd(options);
  t.after(() => restarted.close());
  assert.equal(
    await sendProxyRequest(
      restarted.address,
      `http://${target.host}:${target.port}/restored-alias`,
      "GET",
      "",
      {
        "proxy-authorization": basicProxyAuthorization("node.local%3Asecond", "proxy-secret"),
      },
    ),
    200,
  );
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "first");
});

test("a changed generation drains its listener before removal and port quarantine", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-draining-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  let releaseFirstResponse: (() => void) | undefined;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  t.after(() => releaseFirstResponse?.());
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests, {
    beforeResponse: async () => {
      if (observedRequests.length === 1) {
        await firstResponseGate;
      }
    },
  });
  t.after(() => target.close());
  const oldListener = await startSimulatedMihomoListener(undefined, [], [], "old");
  t.after(() => oldListener.close());
  const newListener = await startSimulatedMihomoListener(undefined, [], [], "new");
  t.after(() => newListener.close());
  const newestListener = await startSimulatedMihomoListener(undefined, [], [], "newest");
  t.after(() => newestListener.close());
  const appliedConfigs: Parameters<
    NonNullable<Parameters<typeof startEgressd>[0]["mihomoRuntime"]>["apply"]
  >[0][] = [];
  const preservedListeners: string[][] = [];
  const removedListeners: string[] = [];
  let applyCount = 0;
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    mihomoRuntime: {
      apply: async (config, context) => {
        appliedConfigs.push(config);
        preservedListeners.push(context.preserveListeners.map((listener) => listener.href));
        applyCount += 1;
        const listener = [oldListener, newListener, newestListener][applyCount - 1];
        assert.ok(listener);
        return new Map([["primary", new URL(`http://${listener.host}:${listener.port}`)]]);
      },
      check: async () => undefined,
      removeListener: async (listener) => {
        removedListeners.push(listener.href);
      },
    },
    port: 0,
    portQuarantineMs: 100,
    proxyAuthentication: false,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const importYaml = (server: string) =>
    fetch(`http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`, {
      body: `proxies:\n  - { name: primary, type: vless, server: ${server}, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n`,
      headers: { authorization: "Bearer test-admin-token" },
      method: "POST",
    });
  assert.equal((await importYaml("old.example.com")).status, 201);
  const targetUrl = `http://${target.host}:${target.port}/generation`;
  const oldRequest = sendProxyRequest(daemon.address, targetUrl, "GET", "");
  await waitFor(async () => observedRequests.length === 1);

  assert.equal((await importYaml("new.example.com")).status, 201);
  assert.equal(appliedConfigs[0]?.listeners[0]?.port, 20_000);
  assert.equal(appliedConfigs[1]?.listeners[0]?.port, 20_001);
  assert.deepEqual(preservedListeners, [[], [`http://${oldListener.host}:${oldListener.port}/`]]);
  assert.deepEqual(removedListeners, []);
  const drainingMetrics = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/metrics`,
    { headers: { authorization: "Bearer test-admin-token" } },
  );
  assert.match(await drainingMetrics.text(), /egresskit_nodes\{status="draining"\} 1/);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", ""), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "new");

  assert.equal((await importYaml("old.example.com")).status, 201);
  assert.equal(appliedConfigs[2]?.listeners[0]?.port, 20_002);
  assert.deepEqual(preservedListeners, [
    [],
    [`http://${oldListener.host}:${oldListener.port}/`],
    [
      `http://${oldListener.host}:${oldListener.port}/`,
      `http://${newListener.host}:${newListener.port}/`,
    ],
  ]);
  await waitFor(async () => removedListeners.length === 1);
  assert.deepEqual(removedListeners, [`http://${newListener.host}:${newListener.port}/`]);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", ""), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "newest");

  releaseFirstResponse?.();
  assert.equal(await oldRequest, 200);
  await waitFor(async () => removedListeners.length === 2);
  assert.deepEqual(
    new Set(removedListeners),
    new Set([
      `http://${newListener.host}:${newListener.port}/`,
      `http://${oldListener.host}:${oldListener.port}/`,
    ]),
  );
});

test("daemon shutdown persists a completed listener removal before closing state", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-removal-shutdown-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const listener = await startSimulatedMihomoListener();
  t.after(() => listener.close());
  let announceRemoval: (() => void) | undefined;
  const removalStarted = new Promise<void>((resolve) => {
    announceRemoval = resolve;
  });
  let finishRemoval: (() => void) | undefined;
  const removalGate = new Promise<void>((resolve) => {
    finishRemoval = resolve;
  });
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    mihomoRuntime: {
      apply: async () =>
        new Map([["primary", new URL(`http://${listener.host}:${listener.port}`)]]),
      check: async () => undefined,
      removeListener: async () => {
        announceRemoval?.();
        await removalGate;
      },
    },
    port: 0,
    portQuarantineMs: 0,
    proxyAuthentication: false,
    stateDirectory,
  });
  const importYaml = (server: string) =>
    fetch(`http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`, {
      body: `proxies:\n  - { name: primary, type: vless, server: ${server}, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n`,
      headers: { authorization: "Bearer test-admin-token" },
      method: "POST",
    });
  assert.equal((await importYaml("old.example.com")).status, 201);
  assert.equal((await importYaml("new.example.com")).status, 201);
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/ready`)).status,
    200,
  );
  await removalStarted;

  let closed = false;
  const closing = daemon.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  finishRemoval?.();
  await closing;

  const state = await openControlState(stateDirectory);
  t.after(() => state.close());
  const replacement = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:\n  - { name: replacement, type: vless, server: replacement.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }\n`,
      { firstListenerPort: 20_000 },
    ),
  );
  assert.equal(replacement.nodes[0]?.listenerPort, 20_000);
});

test("startup removes abandoned draining listeners before quarantining their ports", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-draining-recovery-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const state = await openControlState(stateDirectory);
  const source = { id: "local", kind: "local" as const, locator: "inline" };
  const first = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:\n  - { name: primary, type: vless, server: old.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n`,
      { firstListenerPort: 20_000 },
    ),
  );
  state.saveActiveRevision({ imported: first.imported, source });
  const second = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:\n  - { name: primary, type: vless, server: new.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n`,
      { firstListenerPort: 20_000 },
    ),
  );
  state.saveActiveRevision({ imported: second.imported, source });
  await state.close();
  const listener = await startSimulatedMihomoListener();
  t.after(() => listener.close());
  const removedListeners: string[] = [];
  const daemon = await startEgressd({
    host: "127.0.0.1",
    mihomoRuntime: {
      apply: async () =>
        new Map([["primary", new URL(`http://${listener.host}:${listener.port}`)]]),
      check: async () => undefined,
      removeListener: async (removed) => {
        removedListeners.push(removed.href);
      },
    },
    port: 0,
    portQuarantineMs: 0,
    proxyAuthentication: false,
    stateDirectory,
  });
  await daemon.close();

  assert.deepEqual(removedListeners, ["http://127.0.0.1:20000/"]);
  const recovered = await openControlState(stateDirectory);
  t.after(() => recovered.close());
  const replacement = recovered.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:\n  - { name: replacement, type: vless, server: replacement.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }\n`,
      { firstListenerPort: 20_000 },
    ),
  );
  assert.equal(replacement.nodes[0]?.listenerPort, 20_000);
});

test("runtime checks candidates, rolls back failures, and becomes not-ready if rollback fails", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-runtime-rollback-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const oldListener = await startSimulatedMihomoListener(undefined, [], [], "old");
  t.after(() => oldListener.close());
  const newListener = await startSimulatedMihomoListener(undefined, [], [], "new");
  t.after(() => newListener.close());
  const calls: string[] = [];
  let failRollback = false;
  const healthySignals = {
    activeConnections: 0,
    consecutiveFailures: 0,
    ewmaLatencyMs: 1,
    healthy: true,
    manualWeight: 1,
    successRate: 1,
  };
  const schedulerSignals = new Map([["local:primary", healthySignals]]);
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    mihomoRuntime: {
      apply: async (config) => {
        const server = config.proxies[0]?.server ?? "empty";
        calls.push(`apply:${server}`);
        if (
          server === "apply-failure.example.com" ||
          (failRollback && server === "new.example.com")
        ) {
          throw new Error(`runtime apply failed for ${server}`);
        }
        const listener = server === "new.example.com" ? newListener : oldListener;
        return new Map([["primary", new URL(`http://${listener.host}:${listener.port}`)]]);
      },
      check: async (config) => {
        const server = config.proxies[0]?.server ?? "empty";
        calls.push(`check:${server}`);
        if (server === "check-failure.example.com") {
          throw new Error("runtime static check failed");
        }
      },
      removeListener: async () => undefined,
    },
    port: 0,
    proxyAuthentication: false,
    schedulerSignals,
    stateDirectory,
  });
  t.after(() => daemon.close());
  const importYaml = (server: string) =>
    fetch(`http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`, {
      body: `proxies:\n  - { name: primary, type: vless, server: ${server}, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n`,
      headers: { authorization: "Bearer test-admin-token" },
      method: "POST",
    });
  assert.equal((await importYaml("old.example.com")).status, 201);
  assert.equal((await importYaml("new.example.com")).status, 201);

  calls.length = 0;
  assert.equal((await importYaml("check-failure.example.com")).status, 503);
  assert.deepEqual(calls, ["check:check-failure.example.com", "apply:new.example.com"]);
  const targetUrl = `http://${target.host}:${target.port}/rollback`;
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", ""), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "new");

  calls.length = 0;
  assert.equal((await importYaml("apply-failure.example.com")).status, 503);
  assert.deepEqual(calls, [
    "check:apply-failure.example.com",
    "apply:apply-failure.example.com",
    "apply:new.example.com",
  ]);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", ""), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "new");

  calls.length = 0;
  schedulerSignals.set("local:primary", { ...healthySignals, manualWeight: Number.NaN });
  assert.equal((await importYaml("commit-failure.example.com")).status, 422);
  assert.deepEqual(calls, [
    "check:commit-failure.example.com",
    "apply:commit-failure.example.com",
    "apply:new.example.com",
  ]);
  schedulerSignals.set("local:primary", healthySignals);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", ""), 200);
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "new");

  failRollback = true;
  assert.equal((await importYaml("apply-failure.example.com")).status, 503);
  assert.equal(await sendProxyRequest(daemon.address, targetUrl, "GET", ""), 502);
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/ready`)).status,
    503,
  );
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`)).status,
    200,
  );
  assert.equal(
    (
      await fetch(`http://${daemon.address.host}:${daemon.address.port}/operations/missing`, {
        headers: { authorization: "Bearer test-admin-token" },
      })
    ).status,
    404,
  );
});

test("a rejected candidate preserves a configured active listener", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const listener = await startSimulatedMihomoListener(undefined, [], [], "configured");
  t.after(() => listener.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    mihomoListener: new URL(`http://${listener.host}:${listener.port}`),
    mihomoRuntime: {
      apply: async () => {
        throw new Error("candidate must not be applied");
      },
      check: async () => {
        throw new Error("candidate rejected");
      },
      removeListener: async () => undefined,
    },
    port: 0,
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  const imported = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    {
      body: "proxies:\n  - { name: primary, type: vless, server: rejected.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
      headers: { authorization: "Bearer test-admin-token" },
      method: "POST",
    },
  );
  assert.equal(imported.status, 422);
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/ready`)).status,
    200,
  );
  assert.equal(
    await sendProxyRequest(
      daemon.address,
      `http://${target.host}:${target.port}/configured-active`,
      "GET",
      "",
    ),
    200,
  );
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "configured");
});

test("a Mihomo crash keeps Node live, rejects new proxy traffic, and becomes ready after restart", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const listener = await startSimulatedMihomoListener(undefined, [], [], "restarted");
  t.after(() => listener.close());
  let unexpectedExit: (() => void) | undefined;
  let finishRestart: (() => void) | undefined;
  const restart = new Promise<void>((resolve) => {
    finishRestart = resolve;
  });
  const daemon = await startEgressd({
    host: "127.0.0.1",
    mihomoListener: new URL(`http://${listener.host}:${listener.port}`),
    mihomoRuntime: {
      apply: async () => new Map(),
      check: async () => undefined,
      onUnexpectedExit: (listener_) => {
        unexpectedExit = listener_;
        return () => {
          unexpectedExit = undefined;
        };
      },
      removeListener: async () => undefined,
      restart: () => restart,
    },
    port: 0,
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());
  assert.ok(unexpectedExit);

  unexpectedExit();
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`)).status,
    200,
  );
  assert.equal(
    (await fetch(`http://${daemon.address.host}:${daemon.address.port}/ready`)).status,
    503,
  );
  assert.equal(
    await sendProxyRequest(
      daemon.address,
      `http://${target.host}:${target.port}/runtime-down`,
      "GET",
      "",
    ),
    502,
  );

  finishRestart?.();
  await waitFor(async () => {
    const response = await fetch(`http://${daemon.address.host}:${daemon.address.port}/ready`);
    return response.status === 200;
  });
  assert.equal(
    await sendProxyRequest(
      daemon.address,
      `http://${target.host}:${target.port}/runtime-restarted`,
      "GET",
      "",
    ),
    200,
  );
  assert.equal(observedRequests.at(-1)?.headers["x-egresskit-test-exit"], "restarted");
});

function sendProxyRequest(
  proxy: { host: string; port: number },
  target: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return sendProxyRequestResponse(proxy, target, method, body, headers).then(
    ({ status }) => status,
  );
}

function sendProxyRequestResponse(
  proxy: { host: string; port: number },
  target: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ headers: Record<string, string | string[] | undefined>; status: number }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: proxy.host,
        port: proxy.port,
        path: target,
        method,
        headers: {
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ headers: response.headers, status: response.statusCode ?? 0 }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function basicProxyAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function importLocalNodes(
  daemon: { host: string; port: number },
  names: readonly ("first" | "second")[],
): Promise<number> {
  const nodes = {
    first:
      "  - { name: first, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }",
    second:
      "  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }",
  };
  return fetch(`http://${daemon.host}:${daemon.port}/subscriptions/local`, {
    method: "POST",
    headers: { authorization: "Bearer test-admin-token" },
    body: `proxies:\n${names.map((name) => nodes[name]).join("\n")}\n`,
  }).then((response) => response.status);
}

function setNodeAlias(
  daemon: { host: string; port: number },
  logicalNodeId: string,
  alias: string,
): Promise<number> {
  return fetch(
    `http://${daemon.host}:${daemon.port}/nodes/${encodeURIComponent(logicalNodeId)}/alias`,
    {
      method: "PUT",
      headers: { authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ alias }),
    },
  ).then((response) => response.status);
}

function sendConnectRequest(
  proxy: { host: string; port: number },
  authority: string,
  proxyAuthorization?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, proxy.host);
    let response = "";
    socket.on("connect", () => {
      const authorizationHeader = proxyAuthorization
        ? `Proxy-Authorization: ${proxyAuthorization}\r\n`
        : "";
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorizationHeader}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", reject);
  });
}

async function startHangingTcpListener(onConnection: () => void): Promise<{
  close(): Promise<void>;
  host: string;
  port: number;
}> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    onConnection();
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("hanging listener did not bind a TCP address");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    host: "127.0.0.1",
    port: address.port,
  };
}

async function startResettingHttpListener(): Promise<{
  close(): Promise<void>;
  host: string;
  port: number;
  readonly requests: number;
}> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      requests += 1;
      socket.resetAndDestroy();
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("resetting listener did not bind a TCP address");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    host: "127.0.0.1",
    port: address.port,
    get requests() {
      return requests;
    },
  };
}

function openConnectTunnel(
  proxy: { host: string; port: number },
  authority: string,
  proxyAuthorization: string,
): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, proxy.host);
    let response = "";
    socket.on("connect", () =>
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${proxyAuthorization}\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) {
        socket.removeAllListeners("data");
        assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
        resolve(socket);
      }
    });
    socket.on("error", reject);
  });
}

function sendHttpsPayloadThroughProxy(
  proxy: { host: string; port: number },
  authority: string,
  payload: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, proxy.host);
    let responseHead = "";
    socket.on("connect", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    socket.on("data", (chunk) => {
      responseHead += chunk.toString();
      if (!responseHead.includes("\r\n\r\n")) {
        return;
      }
      socket.removeAllListeners("data");
      assert.match(responseHead, /^HTTP\/1\.1 200 Connection Established/);
      const tlsSocket = connectTestTls(socket);
      tlsSocket.on("secureConnect", () => tlsSocket.write(payload));
      tlsSocket.on("data", () => undefined);
      tlsSocket.on("end", resolve);
      tlsSocket.on("error", reject);
    });
    socket.on("error", reject);
  });
}

async function startTwoExitDaemon(
  t: TestContext,
  schedulerSignals?: Parameters<typeof startEgressd>[0]["schedulerSignals"],
  overrides: Partial<Parameters<typeof startEgressd>[0]> = {},
): Promise<{
  daemon: Awaited<ReturnType<typeof startEgressd>>;
  firstSelections: string[];
  secondSelections: string[];
}> {
  const firstSelections: string[] = [];
  const first = await startSimulatedMihomoListener(undefined, firstSelections, [], "first");
  t.after(() => first.close());
  const secondSelections: string[] = [];
  const second = await startSimulatedMihomoListener(undefined, secondSelections, [], "second");
  t.after(() => second.close());
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    ...(schedulerSignals === undefined ? {} : { schedulerSignals }),
    ...overrides,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async () =>
        new Map([
          ["first", new URL(`http://${first.host}:${first.port}`)],
          ["second", new URL(`http://${second.host}:${second.port}`)],
        ]),
    },
  });
  t.after(() => daemon.close());
  const imported = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
      body: `proxies:
  - { name: first, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
    },
  );
  assert.equal(imported.status, 201);
  return { daemon, firstSelections, secondSelections };
}

test("the test clock advances without waiting for wall-clock time", () => {
  const clock = new ManualClock(1_000);

  clock.advanceBy(250);

  assert.equal(clock.now(), 1_250);
});

test("authorized target feedback is opt-in, temporary, and scoped without leaking targets", async (t) => {
  const disabled = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
  });
  t.after(() => disabled.close());
  const endpoint = `http://${disabled.address.host}:${disabled.address.port}/reputation/feedback`;
  assert.equal(await fetch(endpoint, { method: "POST" }).then((response) => response.status), 401);
  assert.equal(
    await fetch(endpoint, {
      body: JSON.stringify({ nodeId: "local:first", outcome: 429, target: "example.com" }),
      headers: { authorization: "Bearer test-admin-token" },
      method: "POST",
    }).then((response) => response.status),
    409,
  );

  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-reputation-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const logs: unknown[] = [];
  const { daemon } = await startTwoExitDaemon(t, undefined, {
    log: (event) => logs.push(event),
    proxyAuthentication: { tokens: ["proxy-secret"] },
    stateDirectory,
    targetReputationEnabled: true,
  });
  const targetRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(targetRequests);
  t.after(() => target.close());
  const targetUrl = `http://${target.host}:${target.port}/scoped`;
  const strictAuthorization = basicProxyAuthorization("strict.reputation", "proxy-secret");
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": strictAuthorization,
    }),
    200,
  );
  const feedbackEndpoint = `http://${daemon.address.host}:${daemon.address.port}/reputation/feedback`;
  const response = await fetch(feedbackEndpoint, {
    body: JSON.stringify({ nodeId: "local:first", outcome: 403, target: targetUrl, ttlMs: 60_000 }),
    headers: { authorization: "Bearer test-admin-token" },
    method: "POST",
  });
  assert.equal(response.status, 202);
  const recorded = (await response.json()) as Record<string, unknown>;
  assert.equal(recorded.nodeId, "local:first");
  assert.equal(recorded.status, "recorded");
  assert.equal(typeof recorded.expiresAt, "number");
  assert.equal("target" in recorded, false);
  const resultText = await fetch(feedbackEndpoint, {
    body: JSON.stringify({
      nodeId: "local:first",
      outcome: "risk",
      target: "https://sensitive.target.example/private",
    }),
    headers: { authorization: "Bearer test-admin-token" },
    method: "POST",
  }).then((item) => item.text());
  assert.doesNotMatch(resultText, /sensitive\.target\.example/);

  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": strictAuthorization,
    }),
    502,
  );
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("strict.new-reputation", "proxy-secret"),
    }),
    200,
  );
  assert.equal(
    await sendProxyRequest(daemon.address, targetUrl, "GET", "", {
      "proxy-authorization": basicProxyAuthorization("node.local%3Afirst", "proxy-secret"),
    }),
    502,
  );
  const proxied = await sendProxyRequestResponse(daemon.address, targetUrl, "GET", "", {
    "proxy-authorization": basicProxyAuthorization("rotate", "proxy-secret"),
  });
  assert.equal(proxied.status, 200);
  assert.equal(targetRequests.at(-1)?.headers["x-egresskit-test-exit"], "second");
  const metrics = await fetch(`http://${daemon.address.host}:${daemon.address.port}/metrics`, {
    headers: { authorization: "Bearer test-admin-token" },
  }).then((item) => item.text());
  const persisted = await readFile(join(stateDirectory, "control.sqlite"));
  assert.doesNotMatch(metrics, /sensitive\.target\.example/);
  assert.doesNotMatch(JSON.stringify(logs), /sensitive\.target\.example/);
  assert.equal(persisted.includes(Buffer.from("sensitive.target.example")), false);
});

test("ordinary target 403 and 429 responses remain successful node connections", async (t) => {
  for (const statusCode of [403, 429]) {
    const target = await startTargetServer([], { statusCode });
    t.after(() => target.close());
    const mihomo = await startSimulatedMihomoListener();
    t.after(() => mihomo.close());
    const daemon = await startEgressd({
      adminToken: "test-admin-token",
      host: "127.0.0.1",
      mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
      port: 0,
      proxyAuthentication: false,
    });
    t.after(() => daemon.close());

    assert.equal(
      await sendProxyRequest(
        daemon.address,
        `http://${target.host}:${target.port}/business-status`,
        "GET",
        "",
      ),
      statusCode,
    );
    const metrics = await fetch(`http://${daemon.address.host}:${daemon.address.port}/metrics`, {
      headers: { authorization: "Bearer test-admin-token" },
    }).then((response) => response.text());
    assert.match(metrics, /egresskit_connections_total\{result="success"\} 1/);
    assert.match(metrics, /egresskit_connections_total\{result="failure"\} 0/);
  }
});

test("a connection failure can be injected before the target is reached", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const faults = new ConnectionFaultPlan();
  faults.failNext("before-target-connect");
  const mihomo = await startSimulatedMihomoListener(faults);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  const responseStatus = await new Promise<number>((resolve, reject) => {
    const proxyRequest = request(
      {
        host: daemon.address.host,
        method: "GET",
        path: `http://${target.host}:${target.port}/must-not-arrive`,
        port: daemon.address.port,
      },
      (proxyResponse) => {
        proxyResponse.resume();
        proxyResponse.on("end", () => resolve(proxyResponse.statusCode ?? 0));
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });

  assert.equal(responseStatus, 502);
  assert.equal(observedRequests.length, 0);
});

test("a connection failure can be injected immediately after the target connection", async (t) => {
  const observedRequests: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observedRequests);
  t.after(() => target.close());
  const faults = new ConnectionFaultPlan();
  faults.failNext("after-target-connect");
  const mihomo = await startSimulatedMihomoListener(faults);
  t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    mihomoListener: new URL(`http://${mihomo.host}:${mihomo.port}`),
    proxyAuthentication: false,
  });
  t.after(() => daemon.close());

  const responseStatus = await new Promise<number>((resolve, reject) => {
    const proxyRequest = request(
      {
        host: daemon.address.host,
        method: "GET",
        path: `http://${target.host}:${target.port}/must-not-arrive`,
        port: daemon.address.port,
      },
      (proxyResponse) => {
        proxyResponse.resume();
        proxyResponse.on("end", () => resolve(proxyResponse.statusCode ?? 0));
      },
    );
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });

  assert.equal(responseStatus, 502);
  assert.equal(observedRequests.length, 0);
});

test("CONNECT reaches the target through the selected simulated Mihomo listener", async (t) => {
  const receivedRequests: string[] = [];
  const target = await startHttpsTarget(receivedRequests);
  t.after(() => target.close());
  const observedConnectTargets: string[] = [];
  const mihomo = await startSimulatedMihomoListener(undefined, observedConnectTargets);
  t.after(() => mihomo.close());
  const appliedConfigs: unknown[] = [];
  const daemon = await startEgressd({
    adminToken: "test-admin-token",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: false,
    mihomoRuntime: {
      removeListener: async () => undefined,
      check: async () => undefined,
      apply: async (config) => {
        appliedConfigs.push(config);
        return new Map([["primary", new URL(`http://${mihomo.host}:${mihomo.port}`)]]);
      },
    },
  });
  t.after(() => daemon.close());
  const importResponse = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-admin-token",
        "content-type": "application/yaml",
      },
      body: `proxies:
  - name: primary
    type: vless
    server: proxy.example.com
    port: 443
    uuid: 11111111-1111-4111-8111-111111111111
    network: tcp
    tls: true
`,
    },
  );
  assert.equal(importResponse.status, 201);

  const targetAuthority = `${target.host}:${target.port}`;
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(daemon.address.port, daemon.address.host);
    let received = "";
    socket.on("connect", () => {
      socket.write(`CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n")) {
        socket.removeAllListeners("data");
        const tlsSocket = connectTestTls(socket);
        let httpsResponse = "";
        tlsSocket.on("secureConnect", () => {
          tlsSocket.write(
            `GET /secure HTTP/1.1\r\nHost: ${targetAuthority}\r\nConnection: close\r\n\r\n`,
          );
        });
        tlsSocket.on("data", (data) => {
          httpsResponse += data.toString();
        });
        tlsSocket.on("end", () => resolve(`${received}${httpsResponse}`));
        tlsSocket.on("error", reject);
      }
    });
    socket.on("error", reject);
  });

  assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
  assert.match(response, /HTTP\/1\.1 200 OK[\s\S]*observed$/);
  assert.equal(appliedConfigs.length, 1);
  assert.deepEqual(observedConnectTargets, [targetAuthority]);
  assert.deepEqual(receivedRequests, [
    `GET /secure HTTP/1.1\r\nHost: ${targetAuthority}\r\nConnection: close\r\n\r\n`,
  ]);
});
