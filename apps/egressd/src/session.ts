import { createHmac, randomBytes } from "node:crypto";

import type { SchedulerLease } from "./scheduler.js";

export interface SessionScheduler {
  acquire(excludedIds?: ReadonlySet<string>): SchedulerLease | undefined;
  acquireById(id: string): SchedulerLease | undefined;
}

export interface SessionClock {
  now(): number;
}

export interface PersistedSessionBinding {
  createdAt: number;
  lastUsedAt: number;
  logicalNodeId: string;
}

export interface SessionBindingStore {
  countSessionBindings(): number;
  deleteExpiredSessionBindings(
    now: number,
    absoluteTtlMs: number,
    idleTimeoutMs: number,
    activeIdentities: readonly string[],
  ): void;
  getSessionBinding(identity: string): PersistedSessionBinding | undefined;
  loadOrCreateSessionHmacKey(): Buffer;
  saveSessionBinding(identity: string, binding: PersistedSessionBinding): void;
  touchSessionBinding(identity: string, lastUsedAt: number): void;
}

export interface SoftStickySessionOptions {
  absoluteTtlMs?: number;
  clock?: SessionClock;
  idleTimeoutMs?: number;
  maximumActiveSessions?: number;
  maximumConcurrentConnections?: number;
  scheduler: SessionScheduler;
  store?: SessionBindingStore;
}

export class SessionCapacityError extends Error {}

const DEFAULT_ABSOLUTE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_CONCURRENT_CONNECTIONS = 50;
const DEFAULT_MAXIMUM_ACTIVE_SESSIONS = 10_000;

export class SoftStickySessions {
  readonly #absoluteTtlMs: number;
  readonly #clock: SessionClock;
  readonly #hmacKey: Buffer;
  readonly #idleTimeoutMs: number;
  readonly #maximumActiveSessions: number;
  readonly #maximumConcurrentConnections: number;
  readonly #scheduler: SessionScheduler;
  readonly #store: SessionBindingStore;
  readonly #activeConnections = new Map<string, number>();

  constructor(options: SoftStickySessionOptions) {
    this.#absoluteTtlMs = positiveNumber(
      "session absolute TTL",
      options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS,
    );
    this.#idleTimeoutMs = positiveNumber(
      "session idle timeout",
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    );
    this.#maximumActiveSessions = positiveInteger(
      "maximum active sessions",
      options.maximumActiveSessions ?? DEFAULT_MAXIMUM_ACTIVE_SESSIONS,
    );
    this.#maximumConcurrentConnections = positiveInteger(
      "maximum concurrent session connections",
      options.maximumConcurrentConnections ?? DEFAULT_MAXIMUM_CONCURRENT_CONNECTIONS,
    );
    this.#clock = options.clock ?? { now: Date.now };
    this.#scheduler = options.scheduler;
    this.#store = options.store ?? new MemorySessionBindingStore();
    this.#hmacKey = this.#store.loadOrCreateSessionHmacKey();
  }

  acquire(
    sessionKey: string,
    excludedIds: ReadonlySet<string> = new Set(),
  ): SchedulerLease | undefined {
    return this.#acquire(sessionKey, true, excludedIds);
  }

  acquireStrict(sessionKey: string): SchedulerLease | undefined {
    return this.#acquire(sessionKey, false, new Set());
  }

  countActiveSessions(): number {
    this.#store.deleteExpiredSessionBindings(
      this.#clock.now(),
      this.#absoluteTtlMs,
      this.#idleTimeoutMs,
      [...this.#activeConnections.keys()],
    );
    return this.#activeSessionCount();
  }

  #acquire(
    sessionKey: string,
    rebindUnavailable: boolean,
    excludedIds: ReadonlySet<string>,
  ): SchedulerLease | undefined {
    const identity = createHmac("sha256", this.#hmacKey).update(sessionKey).digest("hex");
    const now = this.#clock.now();
    this.#store.deleteExpiredSessionBindings(now, this.#absoluteTtlMs, this.#idleTimeoutMs, [
      ...this.#activeConnections.keys(),
    ]);

    const activeConnections = this.#activeConnections.get(identity) ?? 0;
    if (activeConnections >= this.#maximumConcurrentConnections) {
      throw new SessionCapacityError("session concurrent connection limit reached");
    }

    let binding = this.#store.getSessionBinding(identity);
    let lease =
      binding && !excludedIds.has(binding.logicalNodeId)
        ? this.#scheduler.acquireById(binding.logicalNodeId)
        : undefined;
    if (binding && !lease && !rebindUnavailable) {
      this.#store.touchSessionBinding(identity, now);
      return undefined;
    }
    if (!lease) {
      if (
        !binding &&
        activeConnections === 0 &&
        this.#activeSessionCount() >= this.#maximumActiveSessions
      ) {
        throw new SessionCapacityError("active session limit reached");
      }
      lease = this.#scheduler.acquire(excludedIds);
      if (!lease) {
        return undefined;
      }
      binding = {
        createdAt: now,
        lastUsedAt: now,
        logicalNodeId: lease.candidate.id,
      };
      try {
        this.#store.saveSessionBinding(identity, binding);
      } catch (error) {
        lease.release();
        throw error;
      }
    } else {
      try {
        this.#store.touchSessionBinding(identity, now);
      } catch (error) {
        lease.release();
        throw error;
      }
    }

    this.#activeConnections.set(identity, activeConnections + 1);
    let released = false;
    return {
      candidate: lease.candidate,
      reportConnectionFailure: lease.reportConnectionFailure,
      reportConnectionSuccess: lease.reportConnectionSuccess,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          lease.release();
          this.#store.touchSessionBinding(identity, this.#clock.now());
        } catch {
          // Releasing a connection must remain best-effort when durable state is unavailable.
        } finally {
          const remaining = (this.#activeConnections.get(identity) ?? 1) - 1;
          if (remaining === 0) {
            this.#activeConnections.delete(identity);
          } else {
            this.#activeConnections.set(identity, remaining);
          }
        }
      },
    };
  }

  #activeSessionCount(): number {
    let count = this.#store.countSessionBindings();
    for (const identity of this.#activeConnections.keys()) {
      if (!this.#store.getSessionBinding(identity)) {
        count += 1;
      }
    }
    return count;
  }
}

class MemorySessionBindingStore implements SessionBindingStore {
  readonly #bindings = new Map<string, PersistedSessionBinding>();
  readonly #hmacKey = randomBytes(32);

  countSessionBindings(): number {
    return this.#bindings.size;
  }

  deleteExpiredSessionBindings(
    now: number,
    absoluteTtlMs: number,
    idleTimeoutMs: number,
    activeIdentities: readonly string[],
  ): void {
    const active = new Set(activeIdentities);
    for (const [identity, binding] of this.#bindings) {
      if (
        now - binding.createdAt >= absoluteTtlMs ||
        (!active.has(identity) && now - binding.lastUsedAt >= idleTimeoutMs)
      ) {
        this.#bindings.delete(identity);
      }
    }
  }

  getSessionBinding(identity: string): PersistedSessionBinding | undefined {
    return this.#bindings.get(identity);
  }

  loadOrCreateSessionHmacKey(): Buffer {
    return this.#hmacKey;
  }

  saveSessionBinding(identity: string, binding: PersistedSessionBinding): void {
    this.#bindings.set(identity, binding);
  }

  touchSessionBinding(identity: string, lastUsedAt: number): void {
    const binding = this.#bindings.get(identity);
    if (binding) {
      binding.lastUsedAt = lastUsedAt;
    }
  }
}

function positiveNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return value;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
