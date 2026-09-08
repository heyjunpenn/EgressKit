import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ImportedVlessRevision, NormalizedVlessNode } from "./subscription.js";

const SQLITE_BUSY = 5;

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

export type SubscriptionRevisionStatus =
  | "saved"
  | "downloaded"
  | "parsed"
  | "validated"
  | "suspicious"
  | "accepted"
  | "ready"
  | "healthy";

export interface PersistedSubscriptionRevision {
  forced: boolean;
  history: SubscriptionRevisionStatus[];
  id: number;
  imported?: ImportedVlessRevision;
  nodeCount: number;
  status: SubscriptionRevisionStatus;
  subscriptionId: string;
  suspiciousReason?: string;
}

export type OperationStatus =
  | "queued"
  | "fetching"
  | "parsing"
  | "validating"
  | "applying"
  | "checking"
  | "succeeded"
  | "failed"
  | "interrupted";

export type OperationProcessingStage = Exclude<
  OperationStatus,
  "failed" | "interrupted" | "succeeded"
>;

export interface SubscriptionOperation {
  failure?: { reason: string; stage: OperationProcessingStage };
  history: OperationStatus[];
  id: string;
  revisionId?: number;
  status: OperationStatus;
  subscriptionId: string;
}

export interface ControlState {
  advanceRevision(revisionId: number, status: SubscriptionRevisionStatus): void;
  createForceOperation(revisionId: number): SubscriptionOperation;
  createRefreshOperation(subscriptionId: string): SubscriptionOperation;
  createRemoteSubscription(locator: string): {
    operationId: string;
    revisionId: number;
    subscriptionId: string;
  };
  databasePath: string;
  failOperation(operationId: string, stage: OperationProcessingStage, reason: string): void;
  getOperation(operationId: string): SubscriptionOperation | undefined;
  getRevision(revisionId: number): PersistedSubscriptionRevision | undefined;
  getSubscription(subscriptionId: string): SubscriptionIdentity | undefined;
  loadActiveRevision(): PersistedActiveRevision | undefined;
  saveActiveRevision(input: {
    imported: ImportedVlessRevision;
    revisionId?: number;
    source: SubscriptionIdentity;
  }): PersistedActiveRevision;
  saveValidatedRevision(revisionId: number, imported: ImportedVlessRevision): void;
  markRevisionSuspicious(revisionId: number, reason: string): void;
  settings(): {
    busyTimeoutMs: number;
    foreignKeys: number;
    journalMode: string;
    synchronous: number;
  };
  transitionOperation(operationId: string, status: OperationStatus): void;
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
    interruptUnfinishedOperations(database);
  } catch (error) {
    database?.close();
    releaseLock(lock);
    throw error;
  }
  const controlDatabase = database;

  let closed = false;
  return {
    advanceRevision: (revisionId, status) => advanceRevision(controlDatabase, revisionId, status),
    createForceOperation: (revisionId) => createForceOperation(controlDatabase, revisionId),
    createRefreshOperation: (subscriptionId) =>
      createRefreshOperation(controlDatabase, subscriptionId),
    createRemoteSubscription: (locator) => createRemoteSubscription(controlDatabase, locator),
    databasePath,
    failOperation: (operationId, stage, reason) =>
      failOperation(controlDatabase, operationId, stage, reason),
    getOperation: (operationId) => getOperation(controlDatabase, operationId),
    getRevision: (revisionId) => getRevision(controlDatabase, revisionId),
    getSubscription: (subscriptionId) => getSubscription(controlDatabase, subscriptionId),
    loadActiveRevision: () => loadActiveRevision(controlDatabase),
    saveActiveRevision: (input) => saveActiveRevision(controlDatabase, input),
    saveValidatedRevision: (revisionId, imported) =>
      saveValidatedRevision(controlDatabase, revisionId, imported),
    markRevisionSuspicious: (revisionId, reason) =>
      markRevisionSuspicious(controlDatabase, revisionId, reason),
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
    transitionOperation: (operationId, status) =>
      transitionOperation(controlDatabase, operationId, status),
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
    if ((error as { errcode?: number }).errcode === SQLITE_BUSY) {
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
      mihomo_config_json TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'saved',
      suspicious_reason TEXT,
      forced INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'fetching', 'parsing', 'validating', 'applying', 'checking',
                   'succeeded', 'failed', 'interrupted')
      ),
      failed_stage TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(database, "subscription_revisions", "mihomo_config_json", "TEXT");
  ensureColumn(
    database,
    "subscription_revisions",
    "lifecycle_status",
    "TEXT NOT NULL DEFAULT 'ready'",
  );
  ensureColumn(database, "subscription_revisions", "suspicious_reason", "TEXT");
  ensureColumn(database, "subscription_revisions", "forced", "INTEGER NOT NULL DEFAULT 0");
  database.exec(`
    CREATE TABLE IF NOT EXISTS revision_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES subscription_revisions(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_revisions (
      operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
      revision_id INTEGER NOT NULL REFERENCES subscription_revisions(id)
    );
    INSERT INTO revision_events (revision_id, status, created_at)
      SELECT sr.id, sr.lifecycle_status, sr.created_at
      FROM subscription_revisions sr
      WHERE NOT EXISTS (
        SELECT 1 FROM revision_events re WHERE re.revision_id = sr.id
      );
    PRAGMA user_version = 3;
  `);
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createRemoteSubscription(
  database: DatabaseSync,
  locator: string,
): { operationId: string; revisionId: number; subscriptionId: string } {
  const subscriptionId = randomUUID();
  const operationId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO subscriptions (id, kind, locator) VALUES (?, 'remote', ?)")
      .run(subscriptionId, locator);
    const revisionId = insertPendingRevision(database, subscriptionId);
    insertOperation(database, operationId, subscriptionId, revisionId);
    database.exec("COMMIT");
    return { operationId, revisionId, subscriptionId };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createRefreshOperation(
  database: DatabaseSync,
  subscriptionId: string,
): SubscriptionOperation {
  const subscription = getSubscription(database, subscriptionId);
  if (subscription?.kind !== "remote") {
    throw new Error(`remote subscription not found: ${subscriptionId}`);
  }
  const operationId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    const revisionId = insertPendingRevision(database, subscriptionId);
    insertOperation(database, operationId, subscriptionId, revisionId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getOperation(database, operationId) as SubscriptionOperation;
}

function createForceOperation(database: DatabaseSync, revisionId: number): SubscriptionOperation {
  const revision = getRevision(database, revisionId);
  if (revision?.status !== "suspicious" || !revision.imported) {
    throw new Error(`suspicious revision not found: ${revisionId}`);
  }
  const operationId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("UPDATE subscription_revisions SET forced = 1 WHERE id = ?").run(revisionId);
    insertOperation(database, operationId, revision.subscriptionId, revisionId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getOperation(database, operationId) as SubscriptionOperation;
}

function insertPendingRevision(database: DatabaseSync, subscriptionId: string): number {
  const now = new Date().toISOString();
  const inserted = database
    .prepare(
      `INSERT INTO subscription_revisions
         (subscription_id, normalized_nodes_json, lifecycle_status, created_at)
       VALUES (?, '[]', 'saved', ?)`,
    )
    .run(subscriptionId, now);
  const revisionId = Number(inserted.lastInsertRowid);
  database
    .prepare("INSERT INTO revision_events (revision_id, status, created_at) VALUES (?, 'saved', ?)")
    .run(revisionId, now);
  return revisionId;
}

function insertOperation(
  database: DatabaseSync,
  operationId: string,
  subscriptionId: string,
  revisionId: number,
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO operations
         (id, subscription_id, status, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    )
    .run(operationId, subscriptionId, now, now);
  database
    .prepare(
      "INSERT INTO operation_events (operation_id, status, created_at) VALUES (?, 'queued', ?)",
    )
    .run(operationId, now);
  database
    .prepare("INSERT INTO operation_revisions (operation_id, revision_id) VALUES (?, ?)")
    .run(operationId, revisionId);
}

function getSubscription(
  database: DatabaseSync,
  subscriptionId: string,
): SubscriptionIdentity | undefined {
  const row = database
    .prepare("SELECT id, kind, locator FROM subscriptions WHERE id = ?")
    .get(subscriptionId) as { id: string; kind: "local" | "remote"; locator: string } | undefined;
  return row;
}

function getOperation(
  database: DatabaseSync,
  operationId: string,
): SubscriptionOperation | undefined {
  const row = database
    .prepare(
      `SELECT o.id, o.subscription_id, o.status, o.failed_stage, o.failure_reason,
              orv.revision_id
       FROM operations o
       LEFT JOIN operation_revisions orv ON orv.operation_id = o.id
       WHERE o.id = ?`,
    )
    .get(operationId) as
    | {
        failed_stage: OperationProcessingStage | null;
        failure_reason: string | null;
        id: string;
        revision_id: number | null;
        status: OperationStatus;
        subscription_id: string;
      }
    | undefined;
  if (!row) {
    return undefined;
  }
  const history = database
    .prepare("SELECT status FROM operation_events WHERE operation_id = ? ORDER BY id")
    .all(operationId) as Array<{ status: OperationStatus }>;
  return {
    ...(row.failed_stage && row.failure_reason
      ? { failure: { reason: row.failure_reason, stage: row.failed_stage } }
      : {}),
    history: history.map((event) => event.status),
    id: row.id,
    ...(row.revision_id === null ? {} : { revisionId: row.revision_id }),
    status: row.status,
    subscriptionId: row.subscription_id,
  };
}

function getRevision(
  database: DatabaseSync,
  revisionId: number,
): PersistedSubscriptionRevision | undefined {
  const row = database
    .prepare(
      `SELECT id, subscription_id, normalized_nodes_json, mihomo_config_json,
              lifecycle_status, suspicious_reason, forced
       FROM subscription_revisions WHERE id = ?`,
    )
    .get(revisionId) as
    | {
        forced: number;
        id: number;
        lifecycle_status: SubscriptionRevisionStatus;
        mihomo_config_json: string | null;
        normalized_nodes_json: string;
        subscription_id: string;
        suspicious_reason: string | null;
      }
    | undefined;
  if (!row) {
    return undefined;
  }
  const nodes = JSON.parse(row.normalized_nodes_json) as NormalizedVlessNode[];
  const history = database
    .prepare("SELECT status FROM revision_events WHERE revision_id = ? ORDER BY id")
    .all(revisionId) as Array<{ status: SubscriptionRevisionStatus }>;
  return {
    forced: row.forced === 1,
    history: history.map((event) => event.status),
    id: row.id,
    ...(row.mihomo_config_json === null
      ? {}
      : {
          imported: {
            mihomoConfig: JSON.parse(
              row.mihomo_config_json,
            ) as ImportedVlessRevision["mihomoConfig"],
            nodes,
          },
        }),
    nodeCount: nodes.length,
    status: row.lifecycle_status,
    subscriptionId: row.subscription_id,
    ...(row.suspicious_reason === null ? {} : { suspiciousReason: row.suspicious_reason }),
  };
}

function advanceRevision(
  database: DatabaseSync,
  revisionId: number,
  status: SubscriptionRevisionStatus,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare("UPDATE subscription_revisions SET lifecycle_status = ? WHERE id = ?")
      .run(status, revisionId);
    if (result.changes !== 1) {
      throw new Error(`subscription revision not found: ${revisionId}`);
    }
    database
      .prepare("INSERT INTO revision_events (revision_id, status, created_at) VALUES (?, ?, ?)")
      .run(revisionId, status, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveValidatedRevision(
  database: DatabaseSync,
  revisionId: number,
  imported: ImportedVlessRevision,
): void {
  const result = database
    .prepare(
      `UPDATE subscription_revisions
       SET normalized_nodes_json = ?, mihomo_config_json = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(imported.nodes), JSON.stringify(imported.mihomoConfig), revisionId);
  if (result.changes !== 1) {
    throw new Error(`subscription revision not found: ${revisionId}`);
  }
  advanceRevision(database, revisionId, "validated");
}

function markRevisionSuspicious(database: DatabaseSync, revisionId: number, reason: string): void {
  const result = database
    .prepare("UPDATE subscription_revisions SET suspicious_reason = ? WHERE id = ?")
    .run(reason, revisionId);
  if (result.changes !== 1) {
    throw new Error(`subscription revision not found: ${revisionId}`);
  }
  advanceRevision(database, revisionId, "suspicious");
}

function transitionOperation(
  database: DatabaseSync,
  operationId: string,
  status: OperationStatus,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `UPDATE operations SET status = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'interrupted')`,
      )
      .run(status, now, operationId);
    if (result.changes !== 1) {
      throw new Error(`operation is missing or already terminal: ${operationId}`);
    }
    database
      .prepare("INSERT INTO operation_events (operation_id, status, created_at) VALUES (?, ?, ?)")
      .run(operationId, status, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function failOperation(
  database: DatabaseSync,
  operationId: string,
  stage: OperationProcessingStage,
  reason: string,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `UPDATE operations
         SET status = 'failed', failed_stage = ?, failure_reason = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'interrupted')`,
      )
      .run(stage, reason, now, operationId);
    if (result.changes !== 1) {
      throw new Error(`operation is missing or already terminal: ${operationId}`);
    }
    database
      .prepare(
        "INSERT INTO operation_events (operation_id, status, created_at) VALUES (?, 'failed', ?)",
      )
      .run(operationId, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function interruptUnfinishedOperations(database: DatabaseSync): void {
  const operations = database
    .prepare("SELECT id FROM operations WHERE status NOT IN ('succeeded', 'failed', 'interrupted')")
    .all() as Array<{ id: string }>;
  for (const operation of operations) {
    transitionOperation(database, operation.id, "interrupted");
  }
}

function saveActiveRevision(
  database: DatabaseSync,
  input: {
    imported: ImportedVlessRevision;
    revisionId?: number;
    source: SubscriptionIdentity;
  },
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
    const subscriptionRevisionId =
      input.revisionId ??
      Number(
        database
          .prepare(
            `INSERT INTO subscription_revisions
               (subscription_id, normalized_nodes_json, mihomo_config_json, lifecycle_status,
                created_at)
             VALUES (?, ?, ?, 'ready', ?)`,
          )
          .run(
            input.source.id,
            JSON.stringify(input.imported.nodes),
            JSON.stringify(input.imported.mihomoConfig),
            new Date().toISOString(),
          ).lastInsertRowid,
      );
    if (input.revisionId !== undefined) {
      const revision = getRevision(database, input.revisionId);
      if (!revision || revision.subscriptionId !== input.source.id) {
        throw new Error(`subscription revision not found: ${input.revisionId}`);
      }
    } else {
      database
        .prepare(
          "INSERT INTO revision_events (revision_id, status, created_at) VALUES (?, 'ready', ?)",
        )
        .run(subscriptionRevisionId, new Date().toISOString());
    }
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
