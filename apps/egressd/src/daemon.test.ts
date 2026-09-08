import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
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

test("/live reports Node process liveness without a Mihomo listener", async (t) => {
  const daemon = await startEgressd({ host: "127.0.0.1", port: 0 });
  t.after(() => daemon.close());

  const response = await fetch(`http://${daemon.address.host}:${daemon.address.port}/live`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "live" });
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
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-cli-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const mihomo = await startSimulatedMihomoListener();
  t.after(() => mihomo.close());
  const child = spawn(process.execPath, ["dist/cli.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      EGRESSKIT_HOST: "127.0.0.1",
      EGRESSKIT_ADMIN_TOKEN: "cli-admin-token",
      EGRESSKIT_MIHOMO_HTTP_LISTENER: `http://${mihomo.host}:${mihomo.port}`,
      EGRESSKIT_PORT: "0",
      EGRESSKIT_STATE_DIRECTORY: stateDirectory,
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
    ["first", "first", "first", "second"],
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
  assert.equal(await requestThrough("node.local%3Afirst"), 200);
  assert.deepEqual(
    observedRequests.map((entry) => entry.headers["x-egresskit-test-exit"]),
    ["first", "second", "first"],
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
