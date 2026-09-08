import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  assert.equal(restored?.revisionId, 1);
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

test("control state reclaims a lock left by an exited daemon", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "egresskit-state-"));
  t.after(() => rm(stateDirectory, { force: true, recursive: true }));
  await writeFile(join(stateDirectory, "egressd.lock"), "2147483647\n");

  const state = await openControlState(stateDirectory);
  t.after(() => state.close());

  assert.equal(state.settings().journalMode, "wal");
});
