import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openControlState } from "./state.js";
import { importLocalVlessYaml } from "./subscription.js";

test("control state enables durable SQLite settings and holds a single-writer lock", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const state = await openControlState(stateDirectory);
  t.after(() => state.close());

  assert.deepEqual(state.settings(), {
    busyTimeoutMs: 5_000,
    foreignKeys: 1,
    journalMode: "wal",
    synchronous: 1,
  });

  await assert.rejects(openControlState(stateDirectory), /already owned by another daemon/);
});

test("control state restores the last active subscription revision and node generation", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const source = `proxies:
  - { name: primary, type: vless, server: proxy.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`;
  const imported = importLocalVlessYaml(source, { firstListenerPort: 20_000 });
  const first = await openControlState(stateDirectory);

  const saved = first.saveActiveRevision({
    imported,
    source: { id: "local", kind: "local", locator: "inline" },
  });
  await first.close();

  const reopened = await openControlState(stateDirectory);
  t.after(() => reopened.close());
  const restored = reopened.loadActiveRevision();
  assert.deepEqual(restored, saved);
  assert.equal(restored?.runtimeRevisionId, 1);
  assert.equal(restored?.source.kind, "local");
  assert.deepEqual(restored?.nodes, [
    {
      generation: restored?.nodes[0]?.generation,
      listenerPort: 20_000,
      logicalId: "local:primary",
      node: imported.nodes[0],
    },
  ]);
  assert.match(restored?.nodes[0]?.generation ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(restored?.imported, imported);
});

test("the operating system releases state ownership after a daemon crash", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const stateModuleUrl = new URL("../dist/state.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { openControlState } = await import(${JSON.stringify(stateModuleUrl)});
await openControlState(process.env.EGRESSKIT_TEST_STATE_DIRECTORY);
process.stdout.write("locked\\n");
await new Promise(() => {});`,
    ],
    {
      env: { ...process.env, EGRESSKIT_TEST_STATE_DIRECTORY: stateDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");

  const state = await openControlState(stateDirectory);
  t.after(() => state.close());

  assert.equal(state.settings().journalMode, "wal");
});
