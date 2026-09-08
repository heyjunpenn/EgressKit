import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("node generation planning keeps stable ports and quarantines retired listeners", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-generation-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const state = await openControlState(stateDirectory);
  t.after(() => state.close());
  const source = { id: "local", kind: "local" as const, locator: "inline" };
  const first = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:
  - { name: first, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
`,
      { firstListenerPort: 20_000 },
    ),
    0,
  );
  state.saveActiveRevision({ imported: first.imported, source });

  const reordered = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:
  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
  - { name: first, type: vless, server: one.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
      { firstListenerPort: 20_000 },
    ),
    1,
  );
  assert.deepEqual(
    reordered.nodes.map(({ logicalId, listenerPort }) => ({ listenerPort, logicalId })),
    [
      { listenerPort: 20_001, logicalId: "local:second" },
      { listenerPort: 20_000, logicalId: "local:first" },
    ],
  );
  state.saveActiveRevision({ imported: reordered.imported, source });

  const changed = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:
  - { name: second, type: vless, server: two.example.com, port: 443, uuid: 22222222-2222-4222-8222-222222222222 }
  - { name: first, type: vless, server: changed.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
      { firstListenerPort: 20_000 },
    ),
    2,
  );
  assert.equal(changed.nodes[0]?.listenerPort, 20_001);
  assert.equal(changed.nodes[1]?.listenerPort, 20_002);
  assert.notEqual(changed.nodes[1]?.generation, first.nodes[0]?.generation);
  state.saveActiveRevision({ imported: changed.imported, source });

  assert.equal(
    state.releaseNodeGeneration(
      first.nodes[0]?.logicalId ?? "",
      first.nodes[0]?.generation ?? "",
      first.nodes[0]?.listenerPort ?? 0,
      100,
    ),
    true,
  );
  const thirdSource = `proxies:
  - { name: third, type: vless, server: three.example.com, port: 443, uuid: 33333333-3333-4333-8333-333333333333 }
`;
  const withThirdBeforeQuarantine = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(thirdSource, { firstListenerPort: 20_000 }),
    99,
  );
  assert.notEqual(withThirdBeforeQuarantine.nodes[0]?.listenerPort, 20_000);
  const withThirdAfterQuarantine = state.prepareNodeRevision(
    "local",
    importLocalVlessYaml(thirdSource, { firstListenerPort: 20_000 }),
    100,
  );
  assert.equal(withThirdAfterQuarantine.nodes[0]?.listenerPort, 20_000);
});

test("migration restores active listener leases before allocating a changed generation", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-generation-migration-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  const source = { id: "local", kind: "local" as const, locator: "inline" };
  const first = await openControlState(stateDirectory);
  first.saveActiveRevision({
    imported: importLocalVlessYaml(
      `proxies:
  - { name: primary, type: vless, server: old.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
      { firstListenerPort: 20_000 },
    ),
    source,
  });
  await first.close();

  const database = new DatabaseSync(join(stateDirectory, "control.sqlite"));
  database.exec("DELETE FROM listener_port_leases; PRAGMA user_version = 5;");
  database.close();

  const migrated = await openControlState(stateDirectory);
  t.after(() => migrated.close());
  const changed = migrated.prepareNodeRevision(
    "local",
    importLocalVlessYaml(
      `proxies:
  - { name: primary, type: vless, server: new.example.com, port: 443, uuid: 11111111-1111-4111-8111-111111111111 }
`,
      { firstListenerPort: 20_000 },
    ),
    0,
  );

  assert.equal(changed.nodes[0]?.listenerPort, 20_001);
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
