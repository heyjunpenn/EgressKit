import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("managed Mihomo runtime reports an unexpected process exit and can restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-managed-mihomo-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const binary = join(directory, "mihomo");
  await writeFile(binary, '#!/bin/sh\nif [ "$1" = "-t" ]; then exit 0; fi\nsleep 0.05\nexit 1\n', {
    mode: 0o700,
  });
  await chmod(binary, 0o700);
  const runtime = new ManagedMihomoRuntime({ binary, directory: join(directory, "runtime") });
  t.after(() => runtime.close());
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: node.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  let exits = 0;
  const stopWatching = runtime.onUnexpectedExit(() => {
    exits += 1;
  });
  t.after(stopWatching);

  await runtime.check(revision.mihomoConfig);
  assert.deepEqual(
    await runtime.apply(revision.mihomoConfig, { preserveListeners: [] }),
    new Map([["primary", new URL("http://127.0.0.1:20000")]]),
  );
  await waitForExit(() => exits === 1);
  await runtime.restart(new AbortController().signal);
  await waitForExit(() => exits === 2);
});

test("managed Mihomo runtime replays a failure to a watcher attached after exit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-managed-late-watcher-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const binary = join(directory, "mihomo");
  const exited = join(directory, "exited.log");
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "-t" ]; then exit 0; fi
printf 'exit\\n' >> "${exited}"
exit 1
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const runtime = new ManagedMihomoRuntime({ binary, directory: join(directory, "runtime") });
  t.after(() => runtime.close());
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: node.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );

  await runtime.apply(revision.mihomoConfig, { preserveListeners: [] });
  await waitForFileLines(exited, 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  let exits = 0;
  runtime.onUnexpectedExit(() => {
    exits += 1;
  });

  await waitForExit(() => exits === 1);
});

test("a queued restart succeeds when apply already recovered the failed listener", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-managed-recovered-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const binary = join(directory, "mihomo");
  const starts = join(directory, "starts.log");
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "-t" ]; then exit 0; fi
printf 'start\\n' >> "${starts}"
if [ "$(wc -l < "${starts}")" -eq 1 ]; then exit 1; fi
sleep 30
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const runtime = new ManagedMihomoRuntime({ binary, directory: join(directory, "runtime") });
  t.after(() => runtime.close());
  const revision = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: node.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  let exits = 0;
  runtime.onUnexpectedExit(() => {
    exits += 1;
  });

  await runtime.apply(revision.mihomoConfig, { preserveListeners: [] });
  await waitForExit(() => exits === 1);
  await runtime.apply(revision.mihomoConfig, { preserveListeners: [] });
  await waitForFileLines(starts, 2);

  await runtime.restart(new AbortController().signal);
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 2);
});

test("managed Mihomo runtime reuses unchanged listeners and starts only new generations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-managed-generations-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const binary = join(directory, "mihomo");
  const processLog = join(directory, "processes.log");
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "-t" ]; then exit 0; fi
printf '%s\\n' "$4" >> "${processLog}"
sleep 30
`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const runtime = new ManagedMihomoRuntime({ binary, directory: join(directory, "runtime") });
  t.after(() => runtime.close());
  const first = importLocalVlessYaml(
    "proxies:\n  - { name: primary, type: vless, server: primary.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }\n",
    { firstListenerPort: 20_000 },
  );
  const second = importLocalVlessYaml(
    `proxies:
  - { name: primary, type: vless, server: primary.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: secondary, type: vless, server: secondary.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
    { firstListenerPort: 20_000 },
  );

  await runtime.apply(first.mihomoConfig, { preserveListeners: [] });
  await runtime.apply(second.mihomoConfig, {
    preserveListeners: [new URL("http://127.0.0.1:20000")],
  });

  await waitForFileLines(processLog, 2);
  const configPaths = (await readFile(processLog, "utf8")).trim().split("\n");
  assert.equal(configPaths.length, 2);
  const configs = await Promise.all(
    configPaths.map(async (configPath) => parse(await readFile(configPath, "utf8"))),
  );
  assert.deepEqual(
    configs.map((config) => config.listeners),
    [[second.mihomoConfig.listeners[0]], [second.mihomoConfig.listeners[1]]],
  );
});

async function waitForExit(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for managed Mihomo exit");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForFileLines(path: string, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      if (lines.length >= expected) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${expected} process log entries`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
