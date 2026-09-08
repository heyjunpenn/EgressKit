import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ImportedVlessRevision, NormalizedVlessNode } from "./subscription.js";

export interface SubscriptionIdentity {
  id: string;
  kind: "local" | "remote";
  locator: string;
}

export interface PersistedNodeGeneration {
  generation: string;
  listenerPort: number;
  logicalId: string;
  node: NormalizedVlessNode;
}

export interface PersistedActiveRevision {
  imported: ImportedVlessRevision;
  nodes: PersistedNodeGeneration[];
  revisionId: number;
  source: SubscriptionIdentity;
}

export interface ControlState {
  databasePath: string;
  loadActiveRevision(): PersistedActiveRevision | undefined;
  saveActiveRevision(input: {
    imported: ImportedVlessRevision;
    source: SubscriptionIdentity;
  }): PersistedActiveRevision;
  settings(): {
    busyTimeoutMs: number;
    foreignKeys: number;
    journalMode: string;
    synchronous: number;
  };
  close(): Promise<void>;
}

export async function openControlState(stateDirectory: string): Promise<ControlState> {
  await mkdir(stateDirectory, { recursive: true });
  const lockPath = join(stateDirectory, "egressd.lock");
  const lock = acquireLock(lockPath, stateDirectory);

  const databasePath = join(stateDirectory, "control.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
    migrate(database);
  } catch (error) {
    database?.close();
    releaseLock(lock);
    throw error;
  }
  const controlDatabase = database;

  let closed = false;
  return {
    databasePath,
    loadActiveRevision: () => loadActiveRevision(controlDatabase),
    saveActiveRevision: (input) => saveActiveRevision(controlDatabase, input),
    settings: () => ({
      busyTimeoutMs: (controlDatabase.prepare("PRAGMA busy_timeout").get() as { timeout: number })
        .timeout,
      foreignKeys: (
        controlDatabase.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
      ).foreign_keys,
      journalMode: (
        controlDatabase.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
      ).journal_mode,
      synchronous: (controlDatabase.prepare("PRAGMA synchronous").get() as { synchronous: number })
        .synchronous,
    }),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        controlDatabase.close();
      } finally {
        releaseLock(lock);
      }
    },
  };
}

function acquireLock(lockPath: string, stateDirectory: string): DatabaseSync {
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error(`state directory is already owned by another daemon: ${stateDirectory}`);
    }
    throw error;
  }
}

function releaseLock(lock: DatabaseSync): void {
  try {
    lock.exec("ROLLBACK");
  } finally {
    lock.close();
  }
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
      locator TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscription_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
      normalized_nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_generations (
      revision_id INTEGER NOT NULL REFERENCES subscription_revisions(id) ON DELETE CASCADE,
      logical_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      listener_port INTEGER NOT NULL,
      normalized_node_json TEXT NOT NULL,
      PRIMARY KEY (revision_id, logical_id)
    );
    CREATE TABLE IF NOT EXISTS runtime_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_revision_id INTEGER NOT NULL REFERENCES subscription_revisions(id),
      mihomo_config_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_runtime_revision
      ON runtime_revisions(status) WHERE status = 'active';
    PRAGMA user_version = 1;
  `);
}

function saveActiveRevision(
  database: DatabaseSync,
  input: { imported: ImportedVlessRevision; source: SubscriptionIdentity },
): PersistedActiveRevision {
  const nodes = input.imported.nodes.map((node) => {
    const listener = input.imported.mihomoConfig.listeners.find(
      (candidate) => candidate.proxy === node.name,
    );
    if (!listener) {
      throw new Error(`revision has no listener for ${node.name}`);
    }
    return {
      generation: nodeGeneration(node),
      listenerPort: listener.port,
      logicalId: `${input.source.id}:${node.name}`,
      node,
    };
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO subscriptions (id, kind, locator) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, locator = excluded.locator`,
      )
      .run(input.source.id, input.source.kind, input.source.locator);
    const insertedRevision = database
      .prepare(
        `INSERT INTO subscription_revisions
           (subscription_id, normalized_nodes_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(input.source.id, JSON.stringify(input.imported.nodes), new Date().toISOString());
    const subscriptionRevisionId = Number(insertedRevision.lastInsertRowid);
    const insertNode = database.prepare(
      `INSERT INTO node_generations
         (revision_id, logical_id, generation, listener_port, normalized_node_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const node of nodes) {
      insertNode.run(
        subscriptionRevisionId,
        node.logicalId,
        node.generation,
        node.listenerPort,
        JSON.stringify(node.node),
      );
    }
    database
      .prepare("UPDATE runtime_revisions SET status = 'superseded' WHERE status = 'active'")
      .run();
    const insertedRuntime = database
      .prepare(
        `INSERT INTO runtime_revisions
           (subscription_revision_id, mihomo_config_json, status)
         VALUES (?, ?, 'active')`,
      )
      .run(subscriptionRevisionId, JSON.stringify(input.imported.mihomoConfig));
    database.exec("COMMIT");
    return {
      imported: input.imported,
      nodes,
      revisionId: Number(insertedRuntime.lastInsertRowid),
      source: input.source,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function loadActiveRevision(database: DatabaseSync): PersistedActiveRevision | undefined {
  const row = database
    .prepare(
      `SELECT
         rr.id AS revision_id,
         rr.mihomo_config_json,
         sr.id AS subscription_revision_id,
         sr.normalized_nodes_json,
         s.id AS source_id,
         s.kind AS source_kind,
         s.locator AS source_locator
       FROM runtime_revisions rr
       JOIN subscription_revisions sr ON sr.id = rr.subscription_revision_id
       JOIN subscriptions s ON s.id = sr.subscription_id
       WHERE rr.status = 'active'`,
    )
    .get() as
    | {
        mihomo_config_json: string;
        normalized_nodes_json: string;
        revision_id: number;
        source_id: string;
        source_kind: "local" | "remote";
        source_locator: string;
        subscription_revision_id: number;
      }
    | undefined;
  if (!row) {
    return undefined;
  }
  const nodes = database
    .prepare(
      `SELECT logical_id, generation, listener_port, normalized_node_json
       FROM node_generations WHERE revision_id = ? ORDER BY rowid`,
    )
    .all(row.subscription_revision_id) as Array<{
    generation: string;
    listener_port: number;
    logical_id: string;
    normalized_node_json: string;
  }>;
  const normalizedNodes = JSON.parse(row.normalized_nodes_json) as NormalizedVlessNode[];
  return {
    imported: {
      nodes: normalizedNodes,
      mihomoConfig: JSON.parse(row.mihomo_config_json) as ImportedVlessRevision["mihomoConfig"],
    },
    nodes: nodes.map((node) => ({
      generation: node.generation,
      listenerPort: node.listener_port,
      logicalId: node.logical_id,
      node: JSON.parse(node.normalized_node_json) as NormalizedVlessNode,
    })),
    revisionId: row.revision_id,
    source: {
      id: row.source_id,
      kind: row.source_kind,
      locator: row.source_locator,
    },
  };
}

function nodeGeneration(node: NormalizedVlessNode): string {
  const { name: _name, ...connectionParameters } = node;
  return createHash("sha256").update(JSON.stringify(connectionParameters)).digest("hex");
}
