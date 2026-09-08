const RESTART_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const RESTART_BUDGET_WINDOW_MS = 10 * 60_000;
const MAXIMUM_RESTARTS_PER_WINDOW = 5;

export interface MihomoRecoveryClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface MihomoCrashRecoveryOptions {
  clock?: MihomoRecoveryClock;
  onReady(): void;
  onUnavailable(): void;
  restart(signal: AbortSignal): Promise<void>;
}

export function mihomoRestartDelay(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("Mihomo restart attempt must be a non-negative integer");
  }
  return RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)] as number;
}

export class MihomoCrashRecovery {
  readonly #clock: MihomoRecoveryClock;
  readonly #controller = new AbortController();
  readonly #options: MihomoCrashRecoveryOptions;
  #closed = false;
  #consecutiveRestarts = 0;
  #exitGeneration = 0;
  #recovering = false;
  #recoveryTask: Promise<void> = Promise.resolve();
  #restartAttempts: number[] = [];
  #stableSince: number | undefined;

  constructor(options: MihomoCrashRecoveryOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemRecoveryClock;
  }

  unexpectedExit(): void {
    if (this.#closed) {
      return;
    }
    this.#exitGeneration += 1;
    const now = this.#clock.now();
    if (this.#stableSince !== undefined && now - this.#stableSince >= RESTART_BUDGET_WINDOW_MS) {
      this.#consecutiveRestarts = 0;
      this.#restartAttempts = [];
    }
    this.#stableSince = undefined;
    this.#options.onUnavailable();
    if (this.#recovering) {
      return;
    }
    this.#recovering = true;
    this.#recoveryTask = this.#recover().finally(() => {
      this.#recovering = false;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#controller.abort(new Error("Mihomo crash recovery closed"));
    await this.#recoveryTask;
  }

  async #recover(): Promise<void> {
    while (!this.#closed) {
      const now = this.#clock.now();
      this.#restartAttempts = this.#restartAttempts.filter(
        (attemptedAt) => now - attemptedAt < RESTART_BUDGET_WINDOW_MS,
      );
      if (this.#restartAttempts.length >= MAXIMUM_RESTARTS_PER_WINDOW) {
        return;
      }
      try {
        await this.#clock.sleep(
          mihomoRestartDelay(this.#consecutiveRestarts),
          this.#controller.signal,
        );
      } catch {
        return;
      }
      if (this.#closed) {
        return;
      }
      this.#restartAttempts.push(this.#clock.now());
      this.#consecutiveRestarts += 1;
      const restartGeneration = this.#exitGeneration;
      try {
        await this.#options.restart(this.#controller.signal);
        if (this.#closed) {
          return;
        }
        if (restartGeneration !== this.#exitGeneration) {
          continue;
        }
        this.#stableSince = this.#clock.now();
        this.#options.onReady();
        return;
      } catch {
        // Keep the runtime unavailable and continue within the bounded budget.
      }
    }
  }
}

const systemRecoveryClock: MihomoRecoveryClock = {
  now: Date.now,
  sleep: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};
