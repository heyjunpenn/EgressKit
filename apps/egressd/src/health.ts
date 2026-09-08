import { request } from "node:http";

export type NodeHealthStatus = "cooldown" | "degraded" | "disabled" | "healthy" | "warming";

export interface HealthNode {
  generation?: string;
  id: string;
  listener: URL;
}

export interface NodeHealthSnapshot {
  consecutiveFailures: number;
  cooldownCount: number;
  id: string;
  manuallyEnabled: boolean;
  nextProbeAt: number;
  status: NodeHealthStatus;
}

export type HealthProbe = (listener: URL, target: URL, signal: AbortSignal) => Promise<boolean>;

export interface NodeHealthControllerOptions {
  concurrency?: number;
  cooldownAfterFailures?: number;
  cooldownInitialMs?: number;
  cooldownMaximumMs?: number;
  degradedAfterFailures?: number;
  healthUrls: readonly URL[];
  intervalMs?: number;
  jitterMs?: number;
  onProbeResult?: (id: string, succeeded: boolean) => void;
  onStatusChange?: (id: string, status: NodeHealthStatus) => void;
  probe?: HealthProbe;
  random?: () => number;
  successThreshold?: number;
}

interface NodeHealthState extends NodeHealthSnapshot {
  epoch: number;
  generation: string;
  listener: URL;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export class NodeHealthController {
  readonly #concurrency: number;
  readonly #cooldownAfterFailures: number;
  readonly #cooldownInitialMs: number;
  readonly #cooldownMaximumMs: number;
  readonly #degradedAfterFailures: number;
  readonly #healthUrls: readonly URL[];
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #onProbeResult: ((id: string, succeeded: boolean) => void) | undefined;
  readonly #onStatusChange: ((id: string, status: NodeHealthStatus) => void) | undefined;
  readonly #probe: HealthProbe;
  readonly #random: () => number;
  readonly #successThreshold: number;
  #states = new Map<string, NodeHealthState>();

  constructor(options: NodeHealthControllerOptions) {
    this.#healthUrls = options.healthUrls;
    this.#successThreshold = options.successThreshold ?? 1;
    this.#concurrency = options.concurrency ?? 4;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#jitterMs = options.jitterMs ?? 5_000;
    this.#degradedAfterFailures = options.degradedAfterFailures ?? 2;
    this.#cooldownAfterFailures = options.cooldownAfterFailures ?? 3;
    this.#cooldownInitialMs = options.cooldownInitialMs ?? 60_000;
    this.#cooldownMaximumMs = options.cooldownMaximumMs ?? 15 * 60_000;
    this.#probe =
      options.probe ??
      ((listener, target, signal) =>
        probeThroughMihomo(listener, target, DEFAULT_PROBE_TIMEOUT_MS, signal));
    this.#random = options.random ?? Math.random;
    this.#onProbeResult = options.onProbeResult;
    this.#onStatusChange = options.onStatusChange;
    validateOptions(options, this.#cooldownAfterFailures);
  }

  replaceNodes(nodes: readonly HealthNode[], now = Date.now()): void {
    const next = new Map<string, NodeHealthState>();
    for (const node of nodes) {
      const existing = this.#states.get(node.id);
      const generation = node.generation ?? node.listener.href;
      if (existing?.listener.href === node.listener.href && existing.generation === generation) {
        next.set(node.id, existing);
      } else {
        next.set(node.id, {
          consecutiveFailures: 0,
          cooldownCount: 0,
          epoch: 0,
          generation,
          id: node.id,
          listener: node.listener,
          manuallyEnabled: existing?.manuallyEnabled ?? true,
          nextProbeAt: now + this.#nextJitter(),
          status: "warming",
        });
        this.#onStatusChange?.(
          node.id,
          existing?.manuallyEnabled === false ? "disabled" : "warming",
        );
      }
    }
    this.#states = next;
  }

  recordConnectionFailure(id: string, now = Date.now()): boolean {
    const state = this.#states.get(id);
    if (!state?.manuallyEnabled || state.status === "cooldown") {
      return false;
    }
    this.#applyFailure(state, now);
    if (!Number.isFinite(state.nextProbeAt)) {
      state.nextProbeAt = now + this.#intervalMs + this.#nextJitter();
    }
    return true;
  }

  recordConnectionSuccess(id: string, now = Date.now()): boolean {
    const state = this.#states.get(id);
    if (!state?.manuallyEnabled || state.status === "cooldown") {
      return false;
    }
    state.consecutiveFailures = 0;
    state.epoch += 1;
    this.#ensureProbeScheduled(state, now);
    return true;
  }

  setManualEnabled(id: string, enabled: boolean, now = Date.now()): boolean {
    const state = this.#states.get(id);
    if (!state) {
      return false;
    }
    if (state.manuallyEnabled === enabled) {
      return true;
    }
    state.manuallyEnabled = enabled;
    state.epoch += 1;
    this.#ensureProbeScheduled(state, now);
    this.#onStatusChange?.(state.id, enabled ? state.status : "disabled");
    return true;
  }

  snapshot(): readonly NodeHealthSnapshot[] {
    return [...this.#states.values()].map(
      ({ epoch: _epoch, generation: _generation, listener: _listener, ...snapshot }) => ({
        ...snapshot,
        status: snapshot.manuallyEnabled ? snapshot.status : "disabled",
      }),
    );
  }

  async runDue(now = Date.now(), signal = new AbortController().signal): Promise<void> {
    const due = [...this.#states.values()]
      .filter((state) => state.manuallyEnabled && state.nextProbeAt <= now)
      .map((state) => {
        if (state.status === "cooldown") {
          this.#setStatus(state, "warming");
        }
        state.nextProbeAt = Number.POSITIVE_INFINITY;
        return { epoch: state.epoch, state };
      });
    if (due.length === 0) {
      return;
    }

    const results = new Map<string, number>();
    const tasks = due.flatMap(({ state }) =>
      this.#healthUrls.map((target) => async () => {
        let succeeded = false;
        try {
          succeeded = await this.#probe(state.listener, target, signal);
        } catch {
          succeeded = false;
        }
        if (succeeded) {
          results.set(state.id, (results.get(state.id) ?? 0) + 1);
        }
      }),
    );
    await runWithConcurrency(tasks, this.#concurrency);

    for (const { epoch, state } of due) {
      if (this.#states.get(state.id) !== state || state.epoch !== epoch) {
        continue;
      }
      if (signal.aborted) {
        this.#ensureProbeScheduled(state, now);
        continue;
      }
      if (!state.manuallyEnabled) {
        continue;
      }
      const succeeded = (results.get(state.id) ?? 0) >= this.#successThreshold;
      this.#onProbeResult?.(state.id, succeeded);
      if (succeeded) {
        state.consecutiveFailures = 0;
        state.cooldownCount = 0;
        state.nextProbeAt = now + this.#intervalMs + this.#nextJitter();
        state.epoch += 1;
        this.#setStatus(state, "healthy");
      } else {
        this.#applyFailure(state, now);
        if (state.status !== "cooldown") {
          state.nextProbeAt = now + this.#intervalMs + this.#nextJitter();
        }
      }
    }
  }

  #applyFailure(state: NodeHealthState, now: number): void {
    state.consecutiveFailures += 1;
    state.epoch += 1;
    if (state.consecutiveFailures >= this.#cooldownAfterFailures) {
      state.cooldownCount += 1;
      const cooldownMs = Math.min(
        this.#cooldownMaximumMs,
        this.#cooldownInitialMs * 2 ** (state.cooldownCount - 1),
      );
      state.nextProbeAt = now + cooldownMs;
      this.#setStatus(state, "cooldown");
    } else if (state.consecutiveFailures >= this.#degradedAfterFailures) {
      this.#setStatus(state, "degraded");
    }
  }

  #nextJitter(): number {
    return Math.floor(this.#random() * this.#jitterMs);
  }

  #ensureProbeScheduled(state: NodeHealthState, now: number): void {
    if (!Number.isFinite(state.nextProbeAt)) {
      state.nextProbeAt = now + this.#intervalMs + this.#nextJitter();
    }
  }

  #setStatus(state: NodeHealthState, status: NodeHealthStatus): void {
    if (state.status === status) {
      return;
    }
    state.status = status;
    this.#onStatusChange?.(state.id, state.manuallyEnabled ? status : "disabled");
  }
}

export function probeThroughMihomo(
  listener: URL,
  target: URL,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const probe = request(
      {
        host: listener.hostname,
        method: "GET",
        path: target.href,
        port: Number(listener.port || 80),
        headers: { host: target.host, via: "1.1 egresskit-health" },
        ...(signal === undefined ? {} : { signal }),
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          finish(
            Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400),
          ),
        );
      },
    );
    probe.setTimeout(timeoutMs, () => {
      probe.destroy();
      finish(false);
    });
    probe.once("error", () => finish(false));
    probe.end();
  });
}

async function runWithConcurrency(
  tasks: readonly (() => Promise<void>)[],
  concurrency: number,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      await task?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

function validateOptions(
  options: NodeHealthControllerOptions,
  cooldownAfterFailures: number,
): void {
  if (options.healthUrls.length === 0) {
    throw new Error("at least one health URL is required");
  }
  for (const url of options.healthUrls) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("health URLs must use HTTP or HTTPS");
    }
  }
  const successThreshold = options.successThreshold ?? 1;
  if (
    !Number.isInteger(successThreshold) ||
    successThreshold < 1 ||
    successThreshold > options.healthUrls.length
  ) {
    throw new Error("health success threshold must be within the configured URL count");
  }
  for (const [name, value] of [
    ["health concurrency", options.concurrency ?? 4],
    ["health interval", options.intervalMs ?? DEFAULT_INTERVAL_MS],
    ["degraded failure threshold", options.degradedAfterFailures ?? 2],
    ["cooldown failure threshold", cooldownAfterFailures],
    ["initial cooldown", options.cooldownInitialMs ?? 60_000],
    ["maximum cooldown", options.cooldownMaximumMs ?? 15 * 60_000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if ((options.jitterMs ?? 5_000) < 0) {
    throw new Error("health jitter must not be negative");
  }
  if ((options.degradedAfterFailures ?? 2) >= cooldownAfterFailures) {
    throw new Error("degraded failure threshold must be below cooldown threshold");
  }
  if ((options.cooldownInitialMs ?? 60_000) > (options.cooldownMaximumMs ?? 15 * 60_000)) {
    throw new Error("initial cooldown must not exceed maximum cooldown");
  }
}
