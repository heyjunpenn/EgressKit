import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
