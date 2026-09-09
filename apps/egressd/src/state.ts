import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PersistedProxyToken } from "./proxy-auth.js";
import type { PersistedSessionBinding, SessionBindingStore } from "./session.js";
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
  runtimeRevisionId: number;
  source: SubscriptionIdentity;
}

export interface PreparedNodeRevision {
  imported: ImportedVlessRevision;
  nodes: PersistedNodeGeneration[];
}

export interface PersistedListenerLease {
  generation: string;
  listenerPort: number;
  logicalId: string;
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
  forcePending: boolean;
  forced: boolean;
  history: SubscriptionRevisionStatus[];
  subscriptionRevisionId: number;
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
  subscriptionRevisionId?: number;
  status: OperationStatus;
  subscriptionId: string;
}

export interface ConsoleSubscriptionSummary extends SubscriptionIdentity {
  nodeCount: number;
  revisionId?: number;
  status: SubscriptionRevisionStatus | "pending";
  updatedAt?: string;
}

export interface ConsoleSessionSummary {
  createdAt: number;
  id: string;
  lastUsedAt: number;
  mode: "sticky" | "strict";
  nodeId: string;
}

export interface ConsoleOperationSummary {
  id: string;
  status: OperationStatus;
  subscriptionId: string;
  updatedAt: string;
}

export class NodeAliasConflictError extends Error {}
export class NodeAliasTargetNotFoundError extends Error {}

export interface ControlState extends SessionBindingStore {
  advanceRevision(subscriptionRevisionId: number, status: SubscriptionRevisionStatus): void;
  createForceOperation(subscriptionRevisionId: number): SubscriptionOperation;
  createRefreshOperation(subscriptionId: string): SubscriptionOperation;
  createRemoteSubscription(locator: string): {
    operationId: string;
    subscriptionRevisionId: number;
    subscriptionId: string;
  };
  databasePath: string;
  failOperation(operationId: string, stage: OperationProcessingStage, reason: string): void;
  failForceOperation(
    operationId: string,
    subscriptionRevisionId: number,
    stage: OperationProcessingStage,
    reason: string,
  ): void;
  getOperation(operationId: string): SubscriptionOperation | undefined;
  getNodeAliases(): ReadonlyMap<string, string>;
  getNodeEnabledOverrides(): ReadonlyMap<string, boolean>;
  getRevision(subscriptionRevisionId: number): PersistedSubscriptionRevision | undefined;
  getSubscription(subscriptionId: string): SubscriptionIdentity | undefined;
  listConsoleSessions(): ConsoleSessionSummary[];
  listConsoleOperations(): ConsoleOperationSummary[];
  listConsoleSubscriptions(): ConsoleSubscriptionSummary[];
  listDrainingListenerLeases(): PersistedListenerLease[];
  operationStatusCounts(): Record<string, number>;
  loadProxyTokens(): PersistedProxyToken[] | undefined;
  loadActiveRevision(): PersistedActiveRevision | undefined;
  prepareNodeRevision(
    sourceId: string,
    imported: ImportedVlessRevision,
    now?: number,
  ): PreparedNodeRevision;
  releaseNodeGeneration(
    logicalId: string,
    generation: string,
    listenerPort: number,
    reusableAfter: number,
  ): boolean;
  saveActiveRevision(input: {
    imported: ImportedVlessRevision;
    operationId?: string;
    source: SubscriptionIdentity;
    subscriptionRevisionId?: number;
  }): PersistedActiveRevision;
  saveNodeAlias(logicalNodeId: string, alias: string): void;
  saveNodeEnabledOverride(logicalNodeId: string, enabled: boolean): void;
  saveProxyTokens(tokens: readonly PersistedProxyToken[]): void;
  saveValidatedRevision(subscriptionRevisionId: number, imported: ImportedVlessRevision): void;
  markRevisionAccepted(subscriptionRevisionId: number, operationId: string): void;
  markRevisionSuspicious(subscriptionRevisionId: number, operationId: string, reason: string): void;
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
    advanceRevision: (subscriptionRevisionId, status) =>
      advanceRevision(controlDatabase, subscriptionRevisionId, status),
    createForceOperation: (subscriptionRevisionId) =>
      createForceOperation(controlDatabase, subscriptionRevisionId),
    createRefreshOperation: (subscriptionId) =>
      createRefreshOperation(controlDatabase, subscriptionId),
    createRemoteSubscription: (locator) => createRemoteSubscription(controlDatabase, locator),
    countSessionBindings: () => countSessionBindings(controlDatabase),
    databasePath,
    deleteExpiredSessionBindings: (now, absoluteTtlMs, idleTimeoutMs, activeIdentities) =>
      deleteExpiredSessionBindings(
        controlDatabase,
        now,
        absoluteTtlMs,
        idleTimeoutMs,
        activeIdentities,
      ),
    failOperation: (operationId, stage, reason) =>
      failOperation(controlDatabase, operationId, stage, reason),
    failForceOperation: (operationId, subscriptionRevisionId, stage, reason) =>
      failForceOperation(controlDatabase, operationId, subscriptionRevisionId, stage, reason),
    getOperation: (operationId) => getOperation(controlDatabase, operationId),
    getNodeAliases: () => getNodeAliases(controlDatabase),
    getNodeEnabledOverrides: () => getNodeEnabledOverrides(controlDatabase),
    getRevision: (subscriptionRevisionId) => getRevision(controlDatabase, subscriptionRevisionId),
    getSessionBinding: (identity) => getSessionBinding(controlDatabase, identity),
    getSubscription: (subscriptionId) => getSubscription(controlDatabase, subscriptionId),
    listConsoleSessions: () => listConsoleSessions(controlDatabase),
    listConsoleOperations: () => listConsoleOperations(controlDatabase),
    listConsoleSubscriptions: () => listConsoleSubscriptions(controlDatabase),
    listDrainingListenerLeases: () => listDrainingListenerLeases(controlDatabase),
    loadOrCreateSessionHmacKey: () => loadOrCreateSessionHmacKey(controlDatabase),
    loadActiveRevision: () => loadActiveRevision(controlDatabase),
    loadProxyTokens: () => loadProxyTokens(controlDatabase),
    operationStatusCounts: () => operationStatusCounts(controlDatabase),
    prepareNodeRevision: (sourceId, imported, now) =>
      prepareNodeRevision(controlDatabase, sourceId, imported, now),
    releaseNodeGeneration: (logicalId, generation, listenerPort, reusableAfter) =>
      releaseNodeGeneration(controlDatabase, logicalId, generation, listenerPort, reusableAfter),
    saveActiveRevision: (input) => saveActiveRevision(controlDatabase, input),
    saveNodeAlias: (logicalNodeId, alias) => saveNodeAlias(controlDatabase, logicalNodeId, alias),
    saveNodeEnabledOverride: (logicalNodeId, enabled) =>
      saveNodeEnabledOverride(controlDatabase, logicalNodeId, enabled),
    saveProxyTokens: (tokens) => saveProxyTokens(controlDatabase, tokens),
    saveValidatedRevision: (subscriptionRevisionId, imported) =>
      saveValidatedRevision(controlDatabase, subscriptionRevisionId, imported),
    saveSessionBinding: (identity, binding) =>
      saveSessionBinding(controlDatabase, identity, binding),
    markRevisionAccepted: (subscriptionRevisionId, operationId) =>
      markRevisionAccepted(controlDatabase, subscriptionRevisionId, operationId),
    markRevisionSuspicious: (subscriptionRevisionId, operationId, reason) =>
      markRevisionSuspicious(controlDatabase, subscriptionRevisionId, operationId, reason),
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
    touchSessionBinding: (identity, lastUsedAt, mode) =>
      touchSessionBinding(controlDatabase, identity, lastUsedAt, mode),
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

function countSessionBindings(database: DatabaseSync): number {
  return (
    database.prepare("SELECT COUNT(*) AS count FROM session_bindings").get() as { count: number }
  ).count;
}

function operationStatusCounts(database: DatabaseSync): Record<string, number> {
  const rows = database
    .prepare("SELECT status, COUNT(*) AS count FROM operations GROUP BY status")
    .all() as Array<{ count: number; status: string }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function deleteExpiredSessionBindings(
  database: DatabaseSync,
  now: number,
  absoluteTtlMs: number,
  idleTimeoutMs: number,
  activeIdentities: readonly string[],
): void {
  const placeholders = activeIdentities.map(() => "?").join(", ");
  const idleClause =
    activeIdentities.length === 0
      ? "last_used_at <= ?"
      : `last_used_at <= ? AND session_identity NOT IN (${placeholders})`;
  database
    .prepare(
      `DELETE FROM session_bindings
       WHERE created_at <= ? OR (${idleClause})`,
    )
    .run(now - absoluteTtlMs, now - idleTimeoutMs, ...activeIdentities);
}

function getSessionBinding(
  database: DatabaseSync,
  identity: string,
): PersistedSessionBinding | undefined {
  const row = database
    .prepare(
      `SELECT logical_node_id, created_at, last_used_at, mode
       FROM session_bindings WHERE session_identity = ?`,
    )
    .get(identity) as
    | {
        created_at: number;
        last_used_at: number;
        logical_node_id: string;
        mode: "sticky" | "strict";
      }
    | undefined;
  return row
    ? {
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        logicalNodeId: row.logical_node_id,
        mode: row.mode,
      }
    : undefined;
}

function getNodeAliases(database: DatabaseSync): ReadonlyMap<string, string> {
  const rows = database.prepare("SELECT logical_id, alias FROM node_aliases").all() as Array<{
    alias: string;
    logical_id: string;
  }>;
  return new Map(rows.map((row) => [row.logical_id, row.alias]));
}

function getNodeEnabledOverrides(database: DatabaseSync): ReadonlyMap<string, boolean> {
  const rows = database
    .prepare("SELECT logical_id, enabled FROM node_enabled_overrides")
    .all() as Array<{ enabled: 0 | 1; logical_id: string }>;
  return new Map(rows.map((row) => [row.logical_id, row.enabled === 1]));
}

function saveNodeEnabledOverride(
  database: DatabaseSync,
  logicalNodeId: string,
  enabled: boolean,
): void {
  database
    .prepare(
      `INSERT INTO node_enabled_overrides (logical_id, enabled) VALUES (?, ?)
       ON CONFLICT(logical_id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(logicalNodeId, enabled ? 1 : 0);
}

function saveNodeAlias(database: DatabaseSync, logicalNodeId: string, alias: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const activeNode = database
      .prepare(
        `SELECT 1
         FROM node_generations ng
         JOIN runtime_revisions rr ON rr.subscription_revision_id = ng.revision_id
         WHERE rr.status = 'active' AND ng.logical_id = ?`,
      )
      .get(logicalNodeId);
    if (!activeNode) {
      throw new NodeAliasTargetNotFoundError(`active node not found: ${logicalNodeId}`);
    }
    const aliasOwner = database
      .prepare("SELECT logical_id FROM node_aliases WHERE alias = ?")
      .get(alias) as { logical_id: string } | undefined;
    const aliasesNodeId = database
      .prepare("SELECT 1 FROM node_generations WHERE logical_id = ?")
      .get(alias);
    if ((aliasOwner && aliasOwner.logical_id !== logicalNodeId) || aliasesNodeId) {
      throw new NodeAliasConflictError(`node alias conflicts with an existing selector: ${alias}`);
    }
    database.prepare("DELETE FROM node_aliases WHERE logical_id = ?").run(logicalNodeId);
    database
      .prepare("INSERT INTO node_aliases (alias, logical_id) VALUES (?, ?)")
      .run(alias, logicalNodeId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function loadOrCreateSessionHmacKey(database: DatabaseSync): Buffer {
  const existing = database
    .prepare("SELECT value FROM daemon_metadata WHERE key = 'session_hmac_key'")
    .get() as { value: string } | undefined;
  if (existing) {
    return Buffer.from(existing.value, "hex");
  }
  const key = randomBytes(32);
  database
    .prepare("INSERT INTO daemon_metadata (key, value) VALUES ('session_hmac_key', ?)")
    .run(key.toString("hex"));
  return key;
}

function loadProxyTokens(database: DatabaseSync): PersistedProxyToken[] | undefined {
  const initialized = database
    .prepare("SELECT 1 FROM daemon_metadata WHERE key = 'proxy_tokens_initialized'")
    .get();
  if (!initialized) {
    return undefined;
  }
  const rows = database
    .prepare("SELECT id, token_hash, expires_at FROM proxy_tokens ORDER BY id")
    .all() as Array<{ expires_at: number | null; id: string; token_hash: Uint8Array }>;
  return rows.map((row) => ({
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    hash: Buffer.from(row.token_hash).toString("hex"),
    id: row.id,
  }));
}

function saveProxyTokens(database: DatabaseSync, tokens: readonly PersistedProxyToken[]): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM proxy_tokens").run();
    const insert = database.prepare(
      "INSERT INTO proxy_tokens (id, token_hash, expires_at) VALUES (?, ?, ?)",
    );
    for (const token of tokens) {
      insert.run(token.id, Buffer.from(token.hash, "hex"), token.expiresAt ?? null);
    }
    database
      .prepare(
        "INSERT OR REPLACE INTO daemon_metadata (key, value) VALUES ('proxy_tokens_initialized', '1')",
      )
      .run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveSessionBinding(
  database: DatabaseSync,
  identity: string,
  binding: PersistedSessionBinding,
): void {
  database
    .prepare(
      `INSERT INTO session_bindings
         (session_identity, logical_node_id, created_at, last_used_at, mode)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_identity) DO UPDATE SET
         logical_node_id = excluded.logical_node_id,
         created_at = excluded.created_at,
         last_used_at = excluded.last_used_at,
         mode = excluded.mode`,
    )
    .run(identity, binding.logicalNodeId, binding.createdAt, binding.lastUsedAt, binding.mode);
}

function touchSessionBinding(
  database: DatabaseSync,
  identity: string,
  lastUsedAt: number,
  mode?: "sticky" | "strict",
): void {
  database
    .prepare(
      "UPDATE session_bindings SET last_used_at = ?, mode = COALESCE(?, mode) WHERE session_identity = ?",
    )
    .run(lastUsedAt, mode ?? null, identity);
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
      force_pending INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS session_bindings (
      session_identity TEXT PRIMARY KEY,
      logical_node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'sticky' CHECK (mode IN ('sticky', 'strict'))
    );
    CREATE TABLE IF NOT EXISTS daemon_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proxy_tokens (
      id TEXT PRIMARY KEY,
      token_hash BLOB NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS node_aliases (
      alias TEXT PRIMARY KEY,
      logical_id TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS node_enabled_overrides (
      logical_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS listener_port_leases (
      listener_port INTEGER PRIMARY KEY,
      logical_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'draining', 'quarantined')),
      reusable_after INTEGER
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
  ensureColumn(database, "subscription_revisions", "force_pending", "INTEGER NOT NULL DEFAULT 0");
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
      revision_id INTEGER NOT NULL REFERENCES subscription_revisions(id),
      kind TEXT NOT NULL DEFAULT 'refresh'
    );
    INSERT OR IGNORE INTO listener_port_leases
      (listener_port, logical_id, generation, status, reusable_after)
      SELECT ng.listener_port, ng.logical_id, ng.generation, 'active', NULL
      FROM runtime_revisions rr
      JOIN node_generations ng ON ng.revision_id = rr.subscription_revision_id
      WHERE rr.status = 'active';
    INSERT INTO revision_events (revision_id, status, created_at)
      SELECT sr.id, sr.lifecycle_status, sr.created_at
      FROM subscription_revisions sr
      WHERE NOT EXISTS (
        SELECT 1 FROM revision_events re WHERE re.revision_id = sr.id
      );
    PRAGMA user_version = 7;
  `);
  ensureColumn(database, "operation_revisions", "kind", "TEXT NOT NULL DEFAULT 'refresh'");
  ensureColumn(database, "session_bindings", "mode", "TEXT NOT NULL DEFAULT 'sticky'");
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
): { operationId: string; subscriptionId: string; subscriptionRevisionId: number } {
  const subscriptionId = randomUUID();
  const operationId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO subscriptions (id, kind, locator) VALUES (?, 'remote', ?)")
      .run(subscriptionId, locator);
    const subscriptionRevisionId = insertPendingRevision(database, subscriptionId);
    insertOperation(database, operationId, subscriptionId, subscriptionRevisionId);
    database.exec("COMMIT");
    return { operationId, subscriptionId, subscriptionRevisionId };
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
    const subscriptionRevisionId = insertPendingRevision(database, subscriptionId);
    insertOperation(database, operationId, subscriptionId, subscriptionRevisionId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getOperation(database, operationId) as SubscriptionOperation;
}

export class RevisionForceConflictError extends Error {}

function createForceOperation(
  database: DatabaseSync,
  subscriptionRevisionId: number,
): SubscriptionOperation {
  const operationId = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    const claimed = database
      .prepare(
        `UPDATE subscription_revisions SET force_pending = 1
         WHERE id = ? AND lifecycle_status IN ('suspicious', 'accepted')
           AND suspicious_reason IS NOT NULL AND force_pending = 0`,
      )
      .run(subscriptionRevisionId);
    if (claimed.changes !== 1) {
      const exists = database
        .prepare("SELECT 1 FROM subscription_revisions WHERE id = ?")
        .get(subscriptionRevisionId);
      if (exists) {
        throw new RevisionForceConflictError(
          `revision is not available for force: ${subscriptionRevisionId}`,
        );
      }
      throw new Error(`suspicious revision not found: ${subscriptionRevisionId}`);
    }
    const revision = getRevision(database, subscriptionRevisionId);
    if (!revision?.imported) {
      throw new Error(`suspicious revision not found: ${subscriptionRevisionId}`);
    }
    insertOperation(
      database,
      operationId,
      revision.subscriptionId,
      subscriptionRevisionId,
      "force",
    );
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
  const subscriptionRevisionId = Number(inserted.lastInsertRowid);
  database
    .prepare("INSERT INTO revision_events (revision_id, status, created_at) VALUES (?, 'saved', ?)")
    .run(subscriptionRevisionId, now);
  return subscriptionRevisionId;
}

function insertOperation(
  database: DatabaseSync,
  operationId: string,
  subscriptionId: string,
  subscriptionRevisionId: number,
  kind: "force" | "refresh" = "refresh",
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
    .prepare("INSERT INTO operation_revisions (operation_id, revision_id, kind) VALUES (?, ?, ?)")
    .run(operationId, subscriptionRevisionId, kind);
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

function listConsoleSubscriptions(database: DatabaseSync): ConsoleSubscriptionSummary[] {
  const rows = database
    .prepare(
      `SELECT s.id, s.kind, s.locator, sr.id AS revision_id,
              sr.lifecycle_status, sr.normalized_nodes_json, sr.created_at
       FROM subscriptions s
       LEFT JOIN subscription_revisions sr ON sr.id = (
         SELECT latest.id FROM subscription_revisions latest
         WHERE latest.subscription_id = s.id ORDER BY latest.id DESC LIMIT 1
       )
       ORDER BY s.id`,
    )
    .all() as Array<{
    created_at: string | null;
    id: string;
    kind: "local" | "remote";
    lifecycle_status: SubscriptionRevisionStatus | null;
    locator: string;
    normalized_nodes_json: string | null;
    revision_id: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    locator: row.locator,
    nodeCount:
      row.normalized_nodes_json === null
        ? 0
        : (JSON.parse(row.normalized_nodes_json) as unknown[]).length,
    ...(row.revision_id === null ? {} : { revisionId: row.revision_id }),
    status: row.lifecycle_status ?? "pending",
    ...(row.created_at === null ? {} : { updatedAt: row.created_at }),
  }));
}

function listConsoleSessions(database: DatabaseSync): ConsoleSessionSummary[] {
  const rows = database
    .prepare(
      `SELECT session_identity, logical_node_id, created_at, last_used_at, mode
       FROM session_bindings ORDER BY last_used_at DESC LIMIT 200`,
    )
    .all() as Array<{
    created_at: number;
    last_used_at: number;
    logical_node_id: string;
    mode: "sticky" | "strict";
    session_identity: string;
  }>;
  return rows.map((row) => ({
    createdAt: row.created_at,
    id: `${row.session_identity.slice(0, 8)}…${row.session_identity.slice(-8)}`,
    lastUsedAt: row.last_used_at,
    mode: row.mode,
    nodeId: row.logical_node_id,
  }));
}

function listConsoleOperations(database: DatabaseSync): ConsoleOperationSummary[] {
  return database
    .prepare(
      `SELECT id, subscription_id, status, updated_at
       FROM operations ORDER BY updated_at DESC LIMIT 12`,
    )
    .all()
    .map((row) => {
      const value = row as {
        id: string;
        status: OperationStatus;
        subscription_id: string;
        updated_at: string;
      };
      return {
        id: value.id,
        status: value.status,
        subscriptionId: value.subscription_id,
        updatedAt: value.updated_at,
      };
    });
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
    ...(row.revision_id === null ? {} : { subscriptionRevisionId: row.revision_id }),
    status: row.status,
    subscriptionId: row.subscription_id,
  };
}

function getRevision(
  database: DatabaseSync,
  subscriptionRevisionId: number,
): PersistedSubscriptionRevision | undefined {
  const row = database
    .prepare(
      `SELECT id, subscription_id, normalized_nodes_json, mihomo_config_json,
              lifecycle_status, suspicious_reason, force_pending, forced
       FROM subscription_revisions WHERE id = ?`,
    )
    .get(subscriptionRevisionId) as
    | {
        forced: number;
        force_pending: number;
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
    .all(subscriptionRevisionId) as Array<{ status: SubscriptionRevisionStatus }>;
  return {
    forcePending: row.force_pending === 1,
    forced: row.forced === 1,
    history: history.map((event) => event.status),
    subscriptionRevisionId: row.id,
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
  subscriptionRevisionId: number,
  status: SubscriptionRevisionStatus,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    writeRevisionStatus(database, subscriptionRevisionId, status, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveValidatedRevision(
  database: DatabaseSync,
  subscriptionRevisionId: number,
  imported: ImportedVlessRevision,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `UPDATE subscription_revisions
         SET normalized_nodes_json = ?, mihomo_config_json = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(imported.nodes),
        JSON.stringify(imported.mihomoConfig),
        subscriptionRevisionId,
      );
    if (result.changes !== 1) {
      throw new Error(`subscription revision not found: ${subscriptionRevisionId}`);
    }
    writeRevisionStatus(database, subscriptionRevisionId, "validated", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function markRevisionAccepted(
  database: DatabaseSync,
  subscriptionRevisionId: number,
  operationId: string,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    writeRevisionStatus(database, subscriptionRevisionId, "accepted", now);
    writeOperationStatus(database, operationId, "checking", now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function markRevisionSuspicious(
  database: DatabaseSync,
  subscriptionRevisionId: number,
  operationId: string,
  reason: string,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare("UPDATE subscription_revisions SET suspicious_reason = ? WHERE id = ?")
      .run(reason, subscriptionRevisionId);
    if (result.changes !== 1) {
      throw new Error(`subscription revision not found: ${subscriptionRevisionId}`);
    }
    writeRevisionStatus(database, subscriptionRevisionId, "suspicious", now);
    writeOperationStatus(database, operationId, "succeeded", now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function writeRevisionStatus(
  database: DatabaseSync,
  subscriptionRevisionId: number,
  status: SubscriptionRevisionStatus,
  now: string,
): void {
  const result = database
    .prepare("UPDATE subscription_revisions SET lifecycle_status = ? WHERE id = ?")
    .run(status, subscriptionRevisionId);
  if (result.changes !== 1) {
    throw new Error(`subscription revision not found: ${subscriptionRevisionId}`);
  }
  database
    .prepare("INSERT INTO revision_events (revision_id, status, created_at) VALUES (?, ?, ?)")
    .run(subscriptionRevisionId, status, now);
}

function transitionOperation(
  database: DatabaseSync,
  operationId: string,
  status: OperationStatus,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    writeOperationStatus(database, operationId, status, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function writeOperationStatus(
  database: DatabaseSync,
  operationId: string,
  status: OperationStatus,
  now: string,
): void {
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
    writeFailedOperation(database, operationId, stage, reason, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function failForceOperation(
  database: DatabaseSync,
  operationId: string,
  subscriptionRevisionId: number,
  stage: OperationProcessingStage,
  reason: string,
): void {
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("UPDATE subscription_revisions SET force_pending = 0 WHERE id = ?")
      .run(subscriptionRevisionId);
    writeFailedOperation(database, operationId, stage, reason, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function writeFailedOperation(
  database: DatabaseSync,
  operationId: string,
  stage: OperationProcessingStage,
  reason: string,
  now: string,
): void {
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
}

function interruptUnfinishedOperations(database: DatabaseSync): void {
  const operations = database
    .prepare(
      `SELECT o.id, orv.kind, orv.revision_id
       FROM operations o
       LEFT JOIN operation_revisions orv ON orv.operation_id = o.id
       WHERE o.status NOT IN ('succeeded', 'failed', 'interrupted')`,
    )
    .all() as Array<{
    id: string;
    kind: "force" | "refresh" | null;
    revision_id: number | null;
  }>;
  for (const operation of operations) {
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (operation.kind === "force" && operation.revision_id !== null) {
        database
          .prepare("UPDATE subscription_revisions SET force_pending = 0 WHERE id = ?")
          .run(operation.revision_id);
      }
      writeOperationStatus(database, operation.id, "interrupted", now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function saveActiveRevision(
  database: DatabaseSync,
  input: {
    imported: ImportedVlessRevision;
    operationId?: string;
    source: SubscriptionIdentity;
    subscriptionRevisionId?: number;
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
      input.subscriptionRevisionId ??
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
    if (input.subscriptionRevisionId !== undefined) {
      const revision = getRevision(database, input.subscriptionRevisionId);
      if (!revision || revision.subscriptionId !== input.source.id) {
        throw new Error(`subscription revision not found: ${input.subscriptionRevisionId}`);
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
      .prepare("UPDATE listener_port_leases SET status = 'draining' WHERE status = 'active'")
      .run();
    const activatePort = database.prepare(
      `INSERT INTO listener_port_leases
         (listener_port, logical_id, generation, status, reusable_after)
       VALUES (?, ?, ?, 'active', NULL)
       ON CONFLICT(listener_port) DO UPDATE SET
         logical_id = excluded.logical_id,
         generation = excluded.generation,
         status = 'active',
         reusable_after = NULL`,
    );
    for (const node of nodes) {
      activatePort.run(node.listenerPort, node.logicalId, node.generation);
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
    if (input.subscriptionRevisionId !== undefined) {
      if (input.operationId === undefined) {
        throw new Error("remote revision activation requires an operation");
      }
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE subscription_revisions
           SET forced = CASE WHEN suspicious_reason IS NULL THEN forced ELSE 1 END,
               force_pending = 0
           WHERE id = ?`,
        )
        .run(subscriptionRevisionId);
      writeRevisionStatus(database, subscriptionRevisionId, "ready", now);
      writeOperationStatus(database, input.operationId, "succeeded", now);
    }
    database.exec("COMMIT");
    return {
      imported: input.imported,
      nodes,
      runtimeRevisionId: Number(insertedRuntime.lastInsertRowid),
      source: input.source,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function prepareNodeRevision(
  database: DatabaseSync,
  sourceId: string,
  imported: ImportedVlessRevision,
  now = Date.now(),
): PreparedNodeRevision {
  const leases = database
    .prepare(
      `SELECT listener_port, logical_id, generation, status, reusable_after
       FROM listener_port_leases ORDER BY listener_port`,
    )
    .all() as Array<{
    generation: string;
    listener_port: number;
    logical_id: string;
    reusable_after: number | null;
    status: "active" | "draining" | "quarantined";
  }>;
  const firstListenerPort = Math.min(...imported.mihomoConfig.listeners.map(({ port }) => port));
  const unavailable = new Set(
    leases
      .filter(
        ({ reusable_after: reusableAfter, status }) =>
          status !== "quarantined" || reusableAfter === null || reusableAfter > now,
      )
      .map(({ listener_port: listenerPort }) => listenerPort),
  );
  const assigned = new Set<number>();
  const nodes = imported.nodes.map((node) => {
    const logicalId = `${sourceId}:${node.name}`;
    const generation = nodeGeneration(node);
    const active = leases.find(
      (lease) =>
        lease.logical_id === logicalId &&
        lease.generation === generation &&
        lease.status === "active",
    );
    const reusable = leases.find(
      (lease) =>
        lease.logical_id === logicalId &&
        lease.generation === generation &&
        lease.status === "quarantined" &&
        lease.reusable_after !== null &&
        lease.reusable_after <= now,
    );
    const prior = active ?? reusable;
    let listenerPort = prior?.listener_port;
    if (listenerPort === undefined || assigned.has(listenerPort)) {
      listenerPort = firstListenerPort;
      while (unavailable.has(listenerPort) || assigned.has(listenerPort)) {
        listenerPort += 1;
      }
    }
    if (listenerPort > 65_535) {
      throw new Error("no internal listener port is available");
    }
    assigned.add(listenerPort);
    return { generation, listenerPort, logicalId, node };
  });
  const ports = new Map(nodes.map(({ listenerPort, node }) => [node.name, listenerPort]));
  return {
    imported: {
      mihomoConfig: {
        listeners: imported.mihomoConfig.listeners.map((listener) => ({
          ...listener,
          port: ports.get(listener.proxy) as number,
        })),
        proxies: imported.mihomoConfig.proxies,
      },
      nodes: imported.nodes,
    },
    nodes,
  };
}

function releaseNodeGeneration(
  database: DatabaseSync,
  logicalId: string,
  generation: string,
  listenerPort: number,
  reusableAfter: number,
): boolean {
  const result = database
    .prepare(
      `UPDATE listener_port_leases
       SET status = 'quarantined', reusable_after = ?
       WHERE listener_port = ? AND logical_id = ? AND generation = ?
         AND status IN ('active', 'draining')`,
    )
    .run(reusableAfter, listenerPort, logicalId, generation);
  return result.changes > 0;
}

function listDrainingListenerLeases(database: DatabaseSync): PersistedListenerLease[] {
  return database
    .prepare(
      `SELECT logical_id, generation, listener_port
       FROM listener_port_leases
       WHERE status = 'draining'
       ORDER BY listener_port`,
    )
    .all()
    .map((row) => {
      const lease = row as {
        generation: string;
        listener_port: number;
        logical_id: string;
      };
      return {
        generation: lease.generation,
        listenerPort: lease.listener_port,
        logicalId: lease.logical_id,
      };
    });
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
    runtimeRevisionId: row.revision_id,
    source: {
      id: row.source_id,
      kind: row.source_kind,
      locator: row.source_locator,
    },
  };
}

export function nodeGeneration(node: NormalizedVlessNode): string {
  const { name: _name, ...connectionParameters } = node;
  return createHash("sha256").update(JSON.stringify(connectionParameters)).digest("hex");
}
