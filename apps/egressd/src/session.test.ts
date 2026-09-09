import assert from "node:assert/strict";
import { test } from "node:test";

import { createSchedulerCandidate, type SchedulerLease } from "./scheduler.js";
import {
  type PersistedSessionBinding,
  type SessionBindingStore,
  SoftStickySessions,
} from "./session.js";

test("session persistence failures release scheduler leases and in-memory capacity", () => {
  const scheduler = new TrackingScheduler();
  const store = new FaultingSessionStore();
  const sessions = new SoftStickySessions({
    maximumConcurrentConnections: 1,
    scheduler,
    store,
  });

  store.failNextSave = true;
  assert.throws(() => sessions.acquire("save-failure"), /injected save failure/);
  assert.equal(scheduler.activeLeases, 0);

  const lease = sessions.acquire("touch-failure");
  assert.ok(lease);
  assert.equal(scheduler.activeLeases, 1);
  store.failNextTouch = true;
  assert.doesNotThrow(() => lease.release());
  assert.equal(scheduler.activeLeases, 0);

  const retried = sessions.acquire("touch-failure");
  assert.ok(retried);
  retried.release();
});

test("persisted session bindings retain the requested sticky mode without exposing the key", () => {
  const store = new FaultingSessionStore();
  const sessions = new SoftStickySessions({ scheduler: new TrackingScheduler(), store });

  const lease = sessions.acquireStrict("private-session-key");

  assert.ok(lease);
  assert.equal(store.binding?.mode, "strict");
  assert.doesNotMatch(JSON.stringify(store.binding), /private-session-key/);
  lease.release();
});

class TrackingScheduler {
  activeLeases = 0;
  readonly #candidate = createSchedulerCandidate("only", new URL("http://127.0.0.1:20000"));

  acquire(): SchedulerLease {
    this.activeLeases += 1;
    let released = false;
    return {
      candidate: this.#candidate,
      reportConnectionFailure: () => undefined,
      reportConnectionSuccess: () => undefined,
      release: () => {
        if (!released) {
          released = true;
          this.activeLeases -= 1;
        }
      },
    };
  }

  acquireById(): SchedulerLease {
    return this.acquire();
  }
}

class FaultingSessionStore implements SessionBindingStore {
  binding: PersistedSessionBinding | undefined;
  failNextSave = false;
  failNextTouch = false;

  countSessionBindings(): number {
    return this.binding ? 1 : 0;
  }

  deleteExpiredSessionBindings(): void {}

  getSessionBinding(): PersistedSessionBinding | undefined {
    return this.binding;
  }

  loadOrCreateSessionHmacKey(): Buffer {
    return Buffer.alloc(32, 1);
  }

  saveSessionBinding(_identity: string, binding: PersistedSessionBinding): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected save failure");
    }
    this.binding = binding;
  }

  touchSessionBinding(): void {
    if (this.failNextTouch) {
      this.failNextTouch = false;
      throw new Error("injected touch failure");
    }
  }
}
