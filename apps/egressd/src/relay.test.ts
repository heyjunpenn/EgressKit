import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import test from "node:test";

import { startEgressd } from "./daemon.js";
import { parseRelayTarget, relayHeaders } from "./relay.js";
import {
  ConnectionFaultPlan,
  startHttpsTarget,
  startSimulatedMihomoListener,
  startTargetServer,
} from "./testing/harness.js";

const token = "relay-secret";
const headers = { "x-egresskit-token": token };

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function gateway(t: test.TestContext, listener?: URL) {
  const mihomo = listener ? undefined : await startSimulatedMihomoListener();
  if (mihomo) t.after(() => mihomo.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    adminToken: "admin",
    proxyAuthentication: { tokens: [token] },
    mihomoListener: listener ?? new URL(`http://${mihomo?.host}:${mihomo?.port}`),
    preconnectTimeoutMs: 500,
  });
  t.after(() => daemon.close());
  return { daemon, origin: `http://${daemon.address.host}:${daemon.address.port}` };
}

function relay(origin: string, target: string, route = "rotate") {
  const url = new URL(target);
  return `${origin}/relay/${encodeURIComponent(route)}/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}`;
}

test("relay accepts ordinary POST through an HTTP reverse proxy and keeps gateway credentials private", async (t) => {
  const observed: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observed);
  t.after(() => target.close());
  const { origin } = await gateway(t);
  const reverseProxy = await listen(
    createServer((incoming, response) => {
      const forwarded = request(
        `${origin}${incoming.url}`,
        { method: incoming.method, headers: incoming.headers },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      forwarded.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      incoming.pipe(forwarded);
    }),
  );
  t.after(() => reverseProxy.close());
  const response = await fetch(
    relay(reverseProxy.origin, `http://${target.host}:${target.port}/orders?key=a%2Fb&key=2`),
    {
      method: "POST",
      body: "payload",
      headers: {
        ...headers,
        authorization: "Bearer target-secret",
        "x-forwarded-for": "client-ip",
        "x-egresskit-extra": "remove",
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  await response.text();
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.url, "/orders?key=a%2Fb&key=2");
  assert.equal(observed[0]?.body, "payload");
  assert.equal(observed[0]?.headers.authorization, "Bearer target-secret");
  assert.equal(observed[0]?.headers["x-egresskit-token"], undefined);
  assert.equal(observed[0]?.headers["x-egresskit-extra"], undefined);
  assert.equal(observed[0]?.headers["x-forwarded-for"], undefined);
});

test("relay authenticates independently from target Authorization and validates URL before connecting", async (t) => {
  const { origin } = await gateway(t);
  const path = `${origin}/relay/rotate/https/api.example.com/`;
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  for (const suffix of [
    "rotate/ftp/example.com/",
    "rotate/http/user@example.com/",
    "rotate/http/example.com%2Fother/",
    "rotate/http/example.com\\other/",
  ]) {
    assert.throws(() => parseRelayTarget(`/relay/${suffix}`));
  }
  assert.equal((await fetch(`${origin}/relay/rotate/ftp/example.com/`, { headers })).status, 400);
  assert.deepEqual(
    relayHeaders({
      connection: "x-private, keep-alive",
      "x-private": "secret",
      "proxy-authorization": "secret",
      authorization: "target",
      "content-type": "application/json",
    }),
    {
      authorization: "target",
      "content-type": "application/json",
    },
  );
});

test("relay streams responses before completion and releases its lease when the client cancels", async (t) => {
  let closed = false;
  const target = await listen(
    createServer((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      response.once("close", () => {
        closed = true;
      });
    }),
  );
  t.after(() => target.close());
  const { origin } = await gateway(t);
  const controller = new AbortController();
  const response = await fetch(relay(origin, `${target.origin}/events`), {
    headers,
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  const chunk = await reader.read();
  assert.match(Buffer.from(chunk.value ?? []).toString(), /data: first/);
  controller.abort();
  const deadline = Date.now() + 1_000;
  while (!closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(closed);
  const snapshot = (await fetch(`${origin}/console/snapshot`, {
    headers: { authorization: "Bearer admin" },
  }).then((response) => response.json())) as { nodes: { activeConnections: number }[] };
  assert.equal(snapshot.nodes[0]?.activeConnections, 0);
});

test("relay rewrites redirects into the gateway and passes target error status without node failure", async (t) => {
  const target = await listen(
    createServer((incoming, response) => {
      if (incoming.url === "/first") {
        response.writeHead(302, { location: "/last?x=1" });
        response.end();
      } else {
        response.writeHead(429);
        response.end("target rate limit");
      }
    }),
  );
  t.after(() => target.close());
  const { origin } = await gateway(t);
  const first = await fetch(relay(origin, `${target.origin}/first`), {
    headers,
    redirect: "manual",
  });
  assert.equal(
    first.headers.get("location"),
    `${new URL(relay(origin, `${target.origin}/last?x=1`)).pathname}?x=1`,
  );
  const last = await fetch(relay(origin, `${target.origin}/first`), { headers });
  assert.equal(last.status, 429);
  assert.equal(await last.text(), "target rate limit");
  const metrics = await fetch(`${origin}/metrics`, {
    headers: { authorization: "Bearer admin" },
  }).then((response) => response.text());
  assert.match(metrics, /egresskit_connections_total\{result="failure"\} 0/);
});

test("relay never replays a POST after its body has reached the target", async (t) => {
  const observed: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observed, { closeWithoutResponse: true });
  t.after(() => target.close());
  const { origin } = await gateway(t);
  const response = await fetch(relay(origin, `http://${target.host}:${target.port}/submit`), {
    method: "POST",
    body: "once",
    headers,
  });
  assert.equal(response.status, 502);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.body, "once");
});

test("relay establishes the target before sending a body and rejects untrusted target TLS", async (t) => {
  const faults = new ConnectionFaultPlan();
  faults.failNext("before-target-connect");
  const failed = await startSimulatedMihomoListener(faults);
  t.after(() => failed.close());
  const { origin } = await gateway(t, new URL(`http://${failed.host}:${failed.port}`));
  const response = await fetch(relay(origin, "http://target.invalid/submit"), {
    method: "POST",
    body: "unsent",
    headers,
  });
  assert.equal(response.status, 502);

  const target = await startHttpsTarget([]);
  t.after(() => target.close());
  const healthy = await gateway(t);
  const tls = await fetch(relay(healthy.origin, `https://${target.host}:${target.port}/`), {
    headers,
  });
  assert.equal(tls.status, 502);
});

test("relay rotation and sticky modes share the scheduler, with fallback only before body transmission", async (t) => {
  const target = await startTargetServer([]);
  t.after(() => target.close());
  const connections: string[][] = [[], []];
  const faults = new ConnectionFaultPlan();
  const secondFaults = new ConnectionFaultPlan();
  const first = await startSimulatedMihomoListener(faults, connections[0]);
  const second = await startSimulatedMihomoListener(secondFaults, connections[1]);
  t.after(() => first.close());
  t.after(() => second.close());
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    adminToken: "admin",
    proxyAuthentication: { tokens: [token] },
    preconnectTimeoutMs: 500,
    mihomoRuntime: {
      check: async () => undefined,
      apply: async (config) =>
        new Map(
          config.proxies.map((proxy, index) => [
            proxy.name,
            new URL(`http://127.0.0.1:${index === 0 ? first.port : second.port}`),
          ]),
        ),
      removeListener: async () => undefined,
    },
  });
  t.after(() => daemon.close());
  const origin = `http://${daemon.address.host}:${daemon.address.port}`;
  const imported = await fetch(`${origin}/subscriptions/local`, {
    method: "POST",
    headers: { authorization: "Bearer admin" },
    body: `proxies:
  - { name: first, type: vless, server: one.example, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: second, type: vless, server: two.example, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
  });
  assert.equal(imported.status, 201);
  const url = `http://${target.host}:${target.port}/resource`;
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(relay(origin, url), { headers });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(
    connections.map((entries) => entries.length),
    [1, 1],
  );
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(relay(origin, url, "sticky.customer"), { headers });
    assert.equal(response.status, 200);
    await response.text();
  }
  const sizes = connections.map((entries) => entries.length);
  assert.ok(sizes.includes(3) && sizes.includes(1));
  // Force the next selected transport to reject CONNECT. The body reaches only the fallback.
  (sizes[0] === 3 ? faults : secondFaults).failNext("before-target-connect");
  const fallback = await fetch(relay(origin, url, "sticky.customer"), {
    headers,
    method: "POST",
    body: "once",
  });
  assert.equal(fallback.status, 200);
  assert.equal(((await fallback.json()) as { body: string }).body, "once");
  const previousSizes = connections.map((entries) => entries.length);
  const strict = await fetch(relay(origin, url, "strict.customer"), { headers });
  assert.equal(strict.status, 200);
  await strict.text();
  const strictIndex = connections.findIndex(
    (entries, index) => entries.length > (previousSizes[index] ?? 0),
  );
  (strictIndex === 0 ? faults : secondFaults).failNext("before-target-connect");
  const otherSize = connections[1 - strictIndex]?.length;
  const rejected = await fetch(relay(origin, url, "strict.customer"), { headers });
  assert.equal(rejected.status, 502);
  assert.equal(connections[1 - strictIndex]?.length, otherSize);
  const snapshot = (await fetch(`${origin}/console/snapshot`, {
    headers: { authorization: "Bearer admin" },
  }).then((response) => response.json())) as { nodes: { id: string }[] };
  const selected = await fetch(
    relay(origin, url, `node.${encodeURIComponent(snapshot.nodes[0]?.id ?? "")}`),
    { headers },
  );
  assert.equal(selected.status, 200);
  await selected.text();
});

test("playground executes proxy and relay access through the data plane and keeps gateway tokens out of the target", async (t) => {
  const observed: Parameters<typeof startTargetServer>[0] = [];
  const target = await startTargetServer(observed);
  t.after(() => target.close());
  const { origin } = await gateway(t);
  const execute = (body: unknown, authorization = "admin") =>
    fetch(`${origin}/playground/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const targetUrl = `http://${target.host}:${target.port}/ip?format=json&key=a%2Fb`;
  const input = { mode: "rotate", target: targetUrl };
  assert.equal((await execute({ ...input, access: "relay" }, token)).status, 401);
  for (const access of [undefined, "proxy", "relay"]) {
    const response = await execute({ ...input, ...(access ? { access } : {}) });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { status: number; body: string };
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).url, "/ip?format=json&key=a%2Fb");
  }
  assert.equal(observed.length, 3);
  for (const request of observed) {
    assert.equal(request.headers["x-egresskit-token"], undefined);
    assert.equal(request.headers["proxy-authorization"], undefined);
    assert.equal(request.headers.authorization, undefined);
  }
  assert.equal((await execute({ ...input, access: "unsupported" })).status, 422);
  assert.equal(
    (await execute({ ...input, access: "relay", target: "https://user:secret@example.com" }))
      .status,
    422,
  );
  assert.equal(observed.length, 3);
});
