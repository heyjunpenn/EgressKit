import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { startEgressd } from "./daemon.js";

test("HTTP redacts subscription URLs while authenticated local socket access can reveal them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-control-api-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "egressd.sock");
  const daemon = await startEgressd({
    adminToken: "admin-secret",
    checkMihomoListener: async () => undefined,
    controlSocketPath: socketPath,
    fetchSubscription: async () => new Response("unavailable", { status: 401 }),
    host: "127.0.0.1",
    mihomoRuntime: {
      apply: async (config) =>
        new Map(
          config.listeners.map((listener) => [
            listener.proxy,
            new URL(`http://${listener.listen}:${listener.port}`),
          ]),
        ),
      check: async () => undefined,
      removeListener: async () => undefined,
    },
    port: 0,
    stateDirectory: join(directory, "state"),
  });
  t.after(() => daemon.close());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  const secretUrl = "https://provider.example/subscription?token=secret";
  const created = await socketJson(socketPath, "POST", "/subscriptions/remote", "admin-secret", {
    url: secretUrl,
  });
  const subscriptionId = (created.body as { subscriptionId: string }).subscriptionId;

  const unauthenticated = await socketJson(socketPath, "GET", `/subscriptions/${subscriptionId}`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await socketJson(socketPath, "GET", "/live")).status, 401);
  assert.equal(
    (await socketJson(socketPath, "GET", "http://target.example/path", "admin-secret")).status,
    404,
  );
  const local = await socketJson(
    socketPath,
    "GET",
    `/subscriptions/${subscriptionId}`,
    "admin-secret",
  );
  assert.equal(local.status, 200);
  assert.equal((local.body as { url: string }).url, secretUrl);

  const remote = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/${subscriptionId}`,
    { headers: { authorization: "Bearer admin-secret" } },
  );
  const remoteBody = (await remote.json()) as { url: string };
  assert.equal(remote.status, 200);
  assert.equal(remoteBody.url, "https://provider.example/[redacted]");
  assert.doesNotMatch(JSON.stringify(remoteBody), /secret/);

  const rejected = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/remote`,
    {
      body: JSON.stringify({ url: "not-a-url-with-secret" }),
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  assert.doesNotMatch(await rejected.text(), /secret/);

  const localImport = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    {
      body: "proxies:\n  - { name: local, type: vless, server: local.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
      headers: { authorization: "Bearer admin-secret" },
      method: "POST",
    },
  );
  assert.equal(localImport.status, 201);
  const httpLocal = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/subscriptions/local`,
    { headers: { authorization: "Bearer admin-secret" } },
  );
  assert.deepEqual(await httpLocal.json(), { kind: "local", subscriptionId: "local" });
  assert.deepEqual(
    (await socketJson(socketPath, "GET", "/subscriptions/local", "admin-secret")).body,
    { kind: "local", subscriptionId: "local" },
  );
});

test("a configured control socket path never overwrites an existing file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-control-path-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "must-preserve");
  await writeFile(socketPath, "user-owned");

  await assert.rejects(
    startEgressd({
      adminToken: "admin-secret",
      controlSocketPath: socketPath,
      host: "127.0.0.1",
      port: 0,
      stateDirectory: join(directory, "state"),
    }),
    /EADDRINUSE/,
  );
  assert.equal(await readFile(socketPath, "utf8"), "user-owned");
});

test("startup recovers a stale control socket left by a crashed process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-stale-control-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "stale.sock");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');net.createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal((await stat(socketPath)).isSocket(), true);

  const daemon = await startEgressd({
    adminToken: "admin-secret",
    controlSocketPath: socketPath,
    host: "127.0.0.1",
    port: 0,
    stateDirectory: join(directory, "state"),
  });
  t.after(() => daemon.close());
  assert.equal((await socketJson(socketPath, "GET", "/live", "admin-secret")).status, 200);
});

test("startup preserves and refuses an active control socket owned by another daemon", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-live-control-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "active.sock");
  const owner = await startEgressd({
    adminToken: "owner-secret",
    controlSocketPath: socketPath,
    host: "127.0.0.1",
    port: 0,
    stateDirectory: join(directory, "owner-state"),
  });
  t.after(() => owner.close());

  await assert.rejects(
    startEgressd({
      adminToken: "second-secret",
      controlSocketPath: socketPath,
      host: "127.0.0.1",
      port: 0,
      stateDirectory: join(directory, "second-state"),
    }),
    /EADDRINUSE/,
  );
  assert.equal((await socketJson(socketPath, "GET", "/live", "owner-secret")).status, 200);
});

test("admin API rotates proxy tokens with overlap and never crosses authentication domains", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-token-rotation-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "control.sock");
  const stateDirectory = join(directory, "state");
  let daemon = await startEgressd({
    adminToken: "admin-secret",
    controlSocketPath: socketPath,
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["old-proxy-secret"] },
    stateDirectory,
  });
  t.after(() => daemon.close());
  const before = await socketJson(socketPath, "GET", "/proxy-tokens", "admin-secret");
  const oldId = (before.body as { tokens: Array<{ id: string }> }).tokens[0]?.id as string;
  const faultDatabase = new DatabaseSync(join(stateDirectory, "control.sqlite"));
  t.after(() => faultDatabase.close());
  faultDatabase.exec(`
    CREATE TRIGGER reject_proxy_token_delete
    BEFORE DELETE ON proxy_tokens
    BEGIN
      SELECT RAISE(FAIL, 'injected proxy token persistence failure');
    END;
  `);
  const failedAdd = await socketJson(socketPath, "POST", "/proxy-tokens", "admin-secret", {
    token: "uncommitted-proxy-secret",
  });
  assert.equal(failedAdd.status, 422);
  assert.equal(await proxyStatus(daemon.address, "uncommitted-proxy-secret"), 407);
  faultDatabase.exec("DROP TRIGGER reject_proxy_token_delete");
  const added = await socketJson(socketPath, "POST", "/proxy-tokens", "admin-secret", {
    token: "new-proxy-secret",
  });
  const crossedAdd = await socketJson(socketPath, "POST", "/proxy-tokens", "admin-secret", {
    token: "admin-secret",
  });
  assert.equal(crossedAdd.status, 422);
  assert.doesNotMatch(JSON.stringify(crossedAdd), /admin-secret/);
  const serialized = JSON.stringify({ added, before });
  assert.doesNotMatch(serialized, /old-proxy-secret|new-proxy-secret|admin-secret/);

  assert.notEqual(await proxyStatus(daemon.address, "old-proxy-secret"), 407);
  assert.notEqual(await proxyStatus(daemon.address, "new-proxy-secret"), 407);
  assert.equal(await proxyStatus(daemon.address, "admin-secret"), 407);
  assert.equal(await proxyStatus(daemon.address, ""), 407);
  assert.equal(await connectProxyStatus(daemon.address, ""), 407);
  const crossedAdmin = await fetch(
    `http://${daemon.address.host}:${daemon.address.port}/proxy-tokens`,
    { headers: { authorization: "Bearer new-proxy-secret" } },
  );
  assert.equal(crossedAdmin.status, 401);

  faultDatabase.exec(`
    CREATE TRIGGER reject_proxy_token_delete
    BEFORE DELETE ON proxy_tokens
    BEGIN
      SELECT RAISE(FAIL, 'injected proxy token persistence failure');
    END;
  `);
  const failedRevoke = await socketJson(
    socketPath,
    "DELETE",
    `/proxy-tokens/${oldId}`,
    "admin-secret",
    { graceMs: 0 },
  );
  assert.equal(failedRevoke.status, 422);
  assert.notEqual(await proxyStatus(daemon.address, "old-proxy-secret"), 407);
  faultDatabase.exec("DROP TRIGGER reject_proxy_token_delete");

  const revoked = await socketJson(socketPath, "DELETE", `/proxy-tokens/${oldId}`, "admin-secret", {
    graceMs: 30,
  });
  assert.equal(revoked.status, 202);
  assert.equal((revoked.body as { status: string }).status, "grace");
  assert.equal(typeof (revoked.body as { expiresAt: number }).expiresAt, "number");
  const missing = await socketJson(socketPath, "DELETE", "/proxy-tokens/missing", "admin-secret", {
    graceMs: 30,
  });
  assert.deepEqual(missing, { body: { error: "proxy token not found" }, status: 404 });
  const unbounded = await socketJson(
    socketPath,
    "DELETE",
    `/proxy-tokens/${oldId}`,
    "admin-secret",
    {
      graceMs: 1e308,
    },
  );
  assert.equal(unbounded.status, 422);
  assert.notEqual(await proxyStatus(daemon.address, "old-proxy-secret"), 407);
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.equal(await proxyStatus(daemon.address, "old-proxy-secret"), 407);
  assert.notEqual(await proxyStatus(daemon.address, "new-proxy-secret"), 407);

  await daemon.close();
  daemon = await startEgressd({
    adminToken: "admin-secret",
    controlSocketPath: socketPath,
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["old-proxy-secret"] },
    stateDirectory,
  });
  assert.equal(await proxyStatus(daemon.address, "old-proxy-secret"), 407);
  assert.notEqual(await proxyStatus(daemon.address, "new-proxy-secret"), 407);
  const afterRestart = await socketJson(socketPath, "GET", "/proxy-tokens", "admin-secret");
  assert.equal((afterRestart.body as { tokens: unknown[] }).tokens.length, 1);
});

test("daemon rejects identical configured admin and proxy credentials without echoing them", async () => {
  await assert.rejects(
    startEgressd({
      adminToken: "same-secret",
      host: "127.0.0.1",
      port: 0,
      proxyAuthentication: { tokens: ["same-secret"] },
    }),
    (error: unknown) => {
      assert.match(String(error), /must be distinct/);
      assert.doesNotMatch(String(error), /same-secret/);
      return true;
    },
  );
});

test("daemon rejects an admin credential matching a persisted proxy token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-token-boundary-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const stateDirectory = join(directory, "state");
  const first = await startEgressd({
    adminToken: "initial-admin",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["persisted-proxy-secret"] },
    stateDirectory,
  });
  await first.close();

  await assert.rejects(
    startEgressd({
      adminToken: "persisted-proxy-secret",
      host: "127.0.0.1",
      port: 0,
      proxyAuthentication: { tokens: ["replacement-proxy-secret"] },
      stateDirectory,
    }),
    (error: unknown) => {
      assert.match(String(error), /must be distinct/);
      assert.doesNotMatch(String(error), /persisted-proxy-secret|replacement-proxy-secret/);
      return true;
    },
  );

  const reopened = await startEgressd({
    adminToken: "safe-admin",
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["replacement-proxy-secret"] },
    stateDirectory,
  });
  await reopened.close();
});

test("proxy token initialization failure releases state ownership for retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-token-init-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const stateDirectory = join(directory, "state");

  await assert.rejects(
    startEgressd({
      host: "127.0.0.1",
      port: 0,
      proxyAuthentication: { tokens: [""] },
      stateDirectory,
    }),
    /must not be empty/,
  );
  const daemon = await startEgressd({
    host: "127.0.0.1",
    port: 0,
    proxyAuthentication: { tokens: ["valid-proxy-secret"] },
    stateDirectory,
  });
  await daemon.close();
});

function socketJson(
  socketPath: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ body: unknown; status: number }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const incoming = request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(payload === undefined
            ? {}
            : { "content-length": Buffer.byteLength(payload), "content-type": "application/json" }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const value = Buffer.concat(chunks).toString();
          resolve({
            body: value ? JSON.parse(value) : undefined,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    incoming.on("error", reject);
    incoming.end(payload);
  });
}

function proxyStatus(address: { host: string; port: number }, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: address.host,
      method: "GET",
      path: "http://target.example/path",
      port: address.port,
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`rotate:${token}`).toString("base64")}`,
      },
    });
    outgoing.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function connectProxyStatus(
  address: { host: string; port: number },
  token: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(address.port, address.host);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `CONNECT target.example:443 HTTP/1.1\r\nHost: target.example:443\r\nProxy-Authorization: Basic ${Buffer.from(`rotate:${token}`).toString("base64")}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      const match = /^HTTP\/1\.1 (\d+)/.exec(chunk);
      if (match) {
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on("error", reject);
  });
}
