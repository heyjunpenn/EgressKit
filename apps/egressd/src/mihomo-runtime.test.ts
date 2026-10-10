import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { checkMihomoConfig, ManagedMihomoRuntime } from "./mihomo-runtime.js";
import { importLocalVlessYaml } from "./subscription.js";

test("official Mihomo checks a private candidate file before it can be applied", async () => {
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: node.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  let checkedPath: string | undefined;

  await checkMihomoConfig(revision.mihomoConfig, {
    binary: "/opt/mihomo",
    run: async (binary, arguments_) => {
      assert.equal(binary, "/opt/mihomo");
      assert.deepEqual(arguments_.slice(0, 2), ["-t", "-f"]);
      checkedPath = arguments_[2];
      assert.ok(checkedPath);
      const document = parse(await readFile(checkedPath, "utf8"));
      assert.deepEqual(document, revision.mihomoConfig);
    },
  });

  assert.ok(checkedPath);
  await assert.rejects(access(checkedPath));
});

test("official Mihomo check reports a stable error and removes rejected candidate files", async () => {
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: secret.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  let checkedPath: string | undefined;

  await assert.rejects(
    checkMihomoConfig(revision.mihomoConfig, {
      run: async (_binary, arguments_) => {
        checkedPath = arguments_[2];
        throw new Error("secret.example.com was rejected");
      },
    }),
    /^Error: official Mihomo static check failed$/,
  );

  assert.ok(checkedPath);
  await assert.rejects(access(checkedPath));
});

test("one serving process hot reloads generations, preserves draining nodes and serializes retirement", async (t) => {
  const { runtime, events } = await fakeRuntime(t);
  const first = revision("primary", "old.example", 20_000);
  const second = revision("primary", "new.example", 20_001);
  await runtime.apply(first, { preserveListeners: [] });
  await runtime.apply(second, { preserveListeners: [new URL("http://127.0.0.1:20000")] });
  let log = await events();
  assert.equal(log.filter(({ event }) => event === "start").length, 1);
  const combined = log.at(-1)?.config;
  assert.deepEqual(
    combined.listeners.map(({ port }: { port: number }) => port),
    [20_000, 20_001],
  );
  assert.equal(new Set(combined.proxies.map(({ name }: { name: string }) => name)).size, 2);
  assert.deepEqual(
    combined.proxies.map(({ server }: { server: string }) => server),
    ["old.example", "new.example"],
  );

  await Promise.all([
    runtime.removeListener(new URL("http://127.0.0.1:20000")),
    runtime.apply(second, { preserveListeners: [new URL("http://127.0.0.1:20000")] }),
  ]);
  log = await events();
  assert.equal(log.filter(({ event }) => event === "start").length, 1);
  assert.deepEqual(
    log.at(-1)?.config.listeners.map(({ port }: { port: number }) => port),
    [20_001],
  );
  await assert.rejects(
    runtime.apply(revision("primary", "changed.example", 20_001), { preserveListeners: [] }),
    /without a new port/,
  );
});

test("controller rejection keeps the last applied config and does not launch a second process", async (t) => {
  const { runtime, events } = await fakeRuntime(t);
  await runtime.apply(revision("primary", "old.example", 20_000), { preserveListeners: [] });
  await assert.rejects(
    runtime.apply(revision("primary", "reject.example", 20_001), { preserveListeners: [] }),
    /controller rejected/,
  );
  const log = await events();
  assert.equal(log.filter(({ event }) => event === "start").length, 1);
  assert.deepEqual(
    log.at(-1)?.config.proxies.map(({ server }: { server: string }) => server),
    ["old.example"],
  );
});

test("unexpected exit is replayed to late watchers and recovery restores all listeners once", async (t) => {
  const { runtime, events } = await fakeRuntime(t);
  const config = revision("primary", "old.example", 20_000);
  await runtime.apply(config, { preserveListeners: [] });
  const pid = (await events())[0]?.pid;
  assert.ok(pid);
  process.kill(pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 50));
  let exits = 0;
  const stop = runtime.onUnexpectedExit(() => {
    exits += 1;
  });
  t.after(stop);
  await waitFor(() => exits === 1);
  await runtime.apply(config, { preserveListeners: [] });
  await runtime.restart(new AbortController().signal);
  assert.equal((await events()).filter(({ event }) => event === "start").length, 2);
  await runtime.close();
  assert.equal(exits, 1);
});

test("startup failure and aborted recovery leave no serving child", async (t) => {
  const { runtime, events } = await fakeRuntime(t);
  await runtime.apply(revision("primary", "old.example", 20_000), { preserveListeners: [] });
  process.kill((await events())[0]?.pid as number, "SIGKILL");
  let exited = false;
  runtime.onUnexpectedExit(() => {
    exited = true;
  });
  await waitFor(() => exited);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(runtime.restart(controller.signal), /cancelled/);
  assert.equal((await events()).filter(({ event }) => event === "start").length, 1);
});

function revision(name: string, server: string, port: number) {
  return importLocalVlessYaml(
    `proxies:\n  - { name: ${name}, type: vless, server: ${server}, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n`,
    { firstListenerPort: port },
  ).mihomoConfig;
}

async function fakeRuntime(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-managed-"));
  const binary = join(directory, "mihomo.mjs");
  const log = join(directory, "events.jsonl");
  const yamlPath = createRequire(import.meta.url).resolve("yaml");
  await writeFile(
    binary,
    `#!${process.execPath}
import fs from "node:fs";
import http from "node:http";
import yaml from ${JSON.stringify(yamlPath)};
if (process.argv.includes("-t")) process.exit(0);
let config = yaml.parse(fs.readFileSync(process.argv[process.argv.indexOf("-f") + 1], "utf8"));
const record = event => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, config, pid: process.pid }) + "\\n");
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + config.secret) { res.writeHead(401); res.end(); return; }
  if (req.method === "GET") { res.end("{}"); return; }
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    const next = yaml.parse(JSON.parse(body).payload);
    if (next.proxies.some(proxy => proxy.server === "reject.example")) { res.writeHead(400); res.end(); return; }
    config = next; record("reload"); res.writeHead(204); res.end();
  });
});
server.listen(config["external-controller-unix"], () => record("start"));
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const runtime = new ManagedMihomoRuntime({ binary, directory: join(directory, "runtime") });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime,
    events: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { event: string; config: ReturnType<typeof parse>; pid: number },
        ),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for managed Mihomo exit");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
