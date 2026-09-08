import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type ControlCliClient, runControlCli } from "./control-cli.js";
import { UnixControlClient } from "./control-client.js";

test("subscription add reads stdin, waits by default, and can redact its local result", async () => {
  const calls: Array<{ body?: unknown; method: string; path: string }> = [];
  let operationReads = 0;
  const client: ControlCliClient = {
    request: async (method, path, body) => {
      calls.push({ ...(body === undefined ? {} : { body }), method, path });
      if (method === "POST") {
        return { operationId: "op-1", status: "queued", subscriptionId: "sub-1" };
      }
      if (path === "/operations/op-1") {
        operationReads += 1;
        return { operationId: "op-1", status: operationReads === 1 ? "applying" : "succeeded" };
      }
      return {
        kind: "remote",
        subscriptionId: "sub-1",
        url: "https://provider.example/subscription?token=secret",
      };
    },
  };
  let output = "";

  await runControlCli(
    ["subscription", "add", "--redact"],
    {
      readStdin: async () => "https://provider.example/subscription?token=secret\n",
      write: (value) => {
        output += value;
      },
    },
    client,
  );

  assert.deepEqual(calls, [
    {
      body: { url: "https://provider.example/subscription?token=secret" },
      method: "POST",
      path: "/subscriptions/remote",
    },
    { method: "GET", path: "/operations/op-1" },
    { method: "GET", path: "/operations/op-1" },
    { method: "GET", path: "/subscriptions/sub-1" },
  ]);
  assert.doesNotMatch(output, /secret/);
  assert.match(output, /https:\/\/provider\.example\/\[redacted\]/);
});

test("subscription add --async returns the operation without polling", async () => {
  const calls: string[] = [];
  let output = "";
  await runControlCli(
    ["subscription", "add", "https://provider.example/sub", "--async"],
    {
      readStdin: async () => "",
      write: (value) => {
        output += value;
      },
    },
    {
      request: async (method, path) => {
        calls.push(`${method} ${path}`);
        return { operationId: "op-2", status: "queued", subscriptionId: "sub-2" };
      },
    },
  );

  assert.deepEqual(calls, ["POST /subscriptions/remote"]);
  assert.match(output, /op-2/);
});

test("operation get queries a previously returned asynchronous operation", async () => {
  let output = "";
  await runControlCli(
    ["operation", "get", "op-9"],
    {
      readStdin: async () => "",
      write: (value) => {
        output += value;
      },
    },
    {
      request: async (method, path) => {
        assert.equal(method, "GET");
        assert.equal(path, "/operations/op-9");
        return { operationId: "op-9", status: "failed" };
      },
    },
  );
  assert.match(output, /failed/);
});

test("subscription get reveals the URL by default on the local control channel", async () => {
  let output = "";
  await runControlCli(
    ["subscription", "get", "sub-1"],
    { readStdin: async () => "", write: (value) => (output += value) },
    {
      request: async () => ({
        subscriptionId: "sub-1",
        url: "https://provider.example/subscription?token=visible-locally",
      }),
    },
  );
  assert.match(output, /visible-locally/);
});

test("the Unix control client fails clearly when the daemon is not running", async () => {
  const socketPath = join("/tmp", `egresskit-missing-${process.pid}.sock`);
  const client = new UnixControlClient({ adminToken: "admin-token", socketPath });

  await assert.rejects(client.request("GET", "/operations/op-1"), /egressd is not running/);
});

test("subscription add reports a terminal failed operation as a command failure", async () => {
  let output = "";
  await assert.rejects(
    runControlCli(
      ["subscription", "add", "https://provider.example/sub"],
      { readStdin: async () => "", write: (value) => (output += value) },
      {
        request: async (method) =>
          method === "POST"
            ? { operationId: "op-failed", status: "queued", subscriptionId: "sub-1" }
            : { operationId: "op-failed", status: "failed" },
      },
    ),
    /operation op-failed failed/,
  );
  assert.match(output, /"status": "failed"/);
});

test("the Unix control client rejects malformed daemon JSON", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-malformed-control-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "control.sock");
  const server = createServer((_request, response) => response.end("{"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const client = new UnixControlClient({ adminToken: "admin-token", socketPath });
  await assert.rejects(client.request("GET", "/operations/op-1"), /invalid JSON/);
});

test("the Unix control client rejects a response connection truncated mid-body", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-truncated-control-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const socketPath = join(directory, "control.sock");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": "20" });
    response.flushHeaders();
    response.write("{");
    setImmediate(() => response.socket?.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const client = new UnixControlClient({ adminToken: "admin-token", socketPath });
  await assert.rejects(client.request("GET", "/operations/op-1"), /response was interrupted/);
});
