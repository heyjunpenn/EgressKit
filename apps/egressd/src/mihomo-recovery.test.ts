import assert from "node:assert/strict";
import test from "node:test";

import {
  MihomoCrashRecovery,
  type MihomoRecoveryClock,
  mihomoRestartDelay,
} from "./mihomo-recovery.js";

test("Mihomo restart backoff is immediate, then 1, 2, 5, 10, and at most 30 seconds", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => mihomoRestartDelay(attempt)),
    [0, 1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000],
  );
});

test("Mihomo crash recovery stops after five restarts in ten minutes", async () => {
  const clock = new RecoveryClock();
  let restarts = 0;
  const recovery = new MihomoCrashRecovery({
    clock,
    onReady: () => undefined,
    onUnavailable: () => undefined,
    restart: async () => {
      restarts += 1;
      throw new Error("still unavailable");
    },
  });

  recovery.unexpectedExit();
  await clock.runNextSleep();
  await clock.runNextSleep();
  await clock.runNextSleep();
  await clock.runNextSleep();
  await clock.runNextSleep();
  await flushTasks();

  assert.equal(restarts, 5);
  assert.deepEqual(clock.delays, [0, 1_000, 2_000, 5_000, 10_000]);
  assert.equal(clock.pendingSleeps, 0);
  await recovery.close();
});

test("ten stable minutes reset the restart budget and backoff", async () => {
  const clock = new RecoveryClock();
  let restarts = 0;
  const recovery = new MihomoCrashRecovery({
    clock,
    onReady: () => undefined,
    onUnavailable: () => undefined,
    restart: async () => {
      restarts += 1;
    },
  });

  recovery.unexpectedExit();
  await clock.runNextSleep();
  assert.equal(restarts, 1);
  clock.advanceBy(10 * 60_000 - 1);
  recovery.unexpectedExit();
  await clock.runNextSleep();
  assert.equal(restarts, 2);
  clock.advanceBy(10 * 60_000);
  recovery.unexpectedExit();
  await clock.runNextSleep();

  assert.equal(restarts, 3);
  assert.deepEqual(clock.delays, [0, 1_000, 0]);
  await recovery.close();
});

test("an exit observed during restart cannot mark the crashed runtime ready", async () => {
  const clock = new RecoveryClock();
  let finishFirstRestart: (() => void) | undefined;
  const firstRestart = new Promise<void>((resolve) => {
    finishFirstRestart = resolve;
  });
  let restarts = 0;
  let readyEvents = 0;
  const recovery = new MihomoCrashRecovery({
    clock,
    onReady: () => {
      readyEvents += 1;
    },
    onUnavailable: () => undefined,
    restart: async () => {
      restarts += 1;
      if (restarts === 1) {
        await firstRestart;
      }
    },
  });

  recovery.unexpectedExit();
  await clock.runNextSleep();
  recovery.unexpectedExit();
  finishFirstRestart?.();
  await flushTasks();
  assert.equal(readyEvents, 0);
  await clock.runNextSleep();

  assert.equal(restarts, 2);
  assert.equal(readyEvents, 1);
  await recovery.close();
});

test("closing recovery during a restart cannot publish a late ready state", async () => {
  const clock = new RecoveryClock();
  let finishRestart: (() => void) | undefined;
  const restart = new Promise<void>((resolve) => {
    finishRestart = resolve;
  });
  let readyEvents = 0;
  let restartSignal: AbortSignal | undefined;
  const recovery = new MihomoCrashRecovery({
    clock,
    onReady: () => {
      readyEvents += 1;
    },
    onUnavailable: () => undefined,
    restart: (signal) => {
      restartSignal = signal;
      return restart;
    },
  });

  recovery.unexpectedExit();
  await clock.runNextSleep();
  const closing = recovery.close();
  assert.equal(restartSignal?.aborted, true);
  finishRestart?.();
  await closing;

  assert.equal(readyEvents, 0);
});

class RecoveryClock implements MihomoRecoveryClock {
  readonly delays: number[] = [];
  #now = 0;
  #sleeps: Array<{ milliseconds: number; resolve: () => void }> = [];

  get pendingSleeps(): number {
    return this.#sleeps.length;
  }

  now(): number {
    return this.#now;
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.delays.push(milliseconds);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#sleeps.push({
        milliseconds,
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      });
    });
  }

  advanceBy(milliseconds: number): void {
    this.#now += milliseconds;
  }

  async runNextSleep(): Promise<void> {
    await flushTasks();
    const sleep = this.#sleeps.shift();
    assert.ok(sleep, "expected a pending recovery sleep");
    this.#now += sleep.milliseconds;
    sleep.resolve();
    await flushTasks();
  }
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
