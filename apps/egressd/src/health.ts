import { request } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";

export type NodeHealthStatus = "cooldown" | "degraded" | "disabled" | "healthy" | "warming";

export interface HealthNode {
  generation?: string;
  id: string;
  listener: URL;
}

export interface NodeHealthSnapshot {
  consecutiveFailures: number;
  cooldownCount: number;
  exitIp?: string;
  exitLocation?: string;
  exitProvider?: string;
  exitVerifiedAt?: number;
  id: string;
  manuallyEnabled: boolean;
  nextProbeAt: number;
  status: NodeHealthStatus;
}

export type HealthProbe = (listener: URL, target: URL, signal: AbortSignal) => Promise<boolean>;
export interface ExitIpIdentity {
  city?: string;
  country?: string;
  ip: string;
  provider: string;
  verifiedAt: number;
}

export type ExitIpProbe = (
  listener: URL,
  signal: AbortSignal,
) => Promise<ExitIpIdentity | undefined>;

export interface NodeHealthControllerOptions {
  concurrency?: number;
  cooldownAfterFailures?: number;
  cooldownInitialMs?: number;
  cooldownMaximumMs?: number;
  degradedAfterFailures?: number;
  exitIpProbe?: ExitIpProbe;
  healthUrls: readonly URL[];
  intervalMs?: number;
  jitterMs?: number;
  onExitIdentity?: (id: string, identity: ExitIpIdentity) => void;
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
  nextExitProbeAt: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const EXIT_PROBE_RETRY_MS = 10 * 60_000;

export class NodeHealthController {
  readonly #concurrency: number;
  readonly #cooldownAfterFailures: number;
  readonly #cooldownInitialMs: number;
  readonly #cooldownMaximumMs: number;
  readonly #degradedAfterFailures: number;
  readonly #exitProbeLimiter = new ConcurrencyLimiter(5);
  readonly #exitIpProbe: ExitIpProbe | undefined;
  readonly #healthUrls: readonly URL[];
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #onExitIdentity: ((id: string, identity: ExitIpIdentity) => void) | undefined;
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
    this.#exitIpProbe = options.exitIpProbe;
    this.#cooldownAfterFailures = options.cooldownAfterFailures ?? 3;
    this.#cooldownInitialMs = options.cooldownInitialMs ?? 60_000;
    this.#cooldownMaximumMs = options.cooldownMaximumMs ?? 15 * 60_000;
    this.#probe =
      options.probe ??
      ((listener, target, signal) =>
        probeThroughMihomo(listener, target, DEFAULT_PROBE_TIMEOUT_MS, signal));
    this.#random = options.random ?? Math.random;
    this.#onExitIdentity = options.onExitIdentity;
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
          nextExitProbeAt: now,
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
      ({
        epoch: _epoch,
        generation: _generation,
        listener: _listener,
        nextExitProbeAt: _nextExitProbeAt,
        ...snapshot
      }) => ({ ...snapshot, status: snapshot.manuallyEnabled ? snapshot.status : "disabled" }),
    );
  }

  async verifyExit(
    id: string,
    signal = new AbortController().signal,
  ): Promise<ExitIpIdentity | undefined> {
    const state = this.#states.get(id);
    const exitIpProbe = this.#exitIpProbe;
    if (!state || !exitIpProbe) return undefined;
    const epoch = state.epoch;
    const identity = await this.#exitProbeLimiter.run(() => exitIpProbe(state.listener, signal));
    if (
      !identity ||
      signal.aborted ||
      this.#states.get(id) !== state ||
      state.epoch !== epoch ||
      !state.manuallyEnabled
    ) {
      return undefined;
    }
    this.#recordExitIdentity(state, identity);
    return identity;
  }

  restoreExitIdentity(id: string, identity: ExitIpIdentity): boolean {
    const state = this.#states.get(id);
    if (!state) return false;
    this.#recordExitIdentity(state, identity);
    return true;
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
    const exitIdentities = new Map<string, ExitIpIdentity>();
    const exitIpProbe = this.#exitIpProbe;
    if (exitIpProbe) {
      await runWithConcurrency(
        due
          .filter(({ state }) => state.exitIp === undefined && state.nextExitProbeAt <= now)
          .map(({ state }) => async () => {
            state.nextExitProbeAt = now + EXIT_PROBE_RETRY_MS;
            const identity = await this.#exitProbeLimiter
              .run(() => exitIpProbe(state.listener, signal))
              .catch(() => undefined);
            if (identity !== undefined) exitIdentities.set(state.id, identity);
          }),
        5,
      );
    }

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
        const identity = exitIdentities.get(state.id);
        if (identity !== undefined) this.#recordExitIdentity(state, identity);
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

  #recordExitIdentity(state: NodeHealthState, identity: ExitIpIdentity): void {
    state.exitIp = identity.ip;
    state.exitProvider = identity.provider;
    state.exitVerifiedAt = identity.verifiedAt;
    state.nextExitProbeAt = Number.POSITIVE_INFINITY;
    const location = [identity.country, identity.city].filter(Boolean).join("-");
    if (location) state.exitLocation = location;
    this.#onExitIdentity?.(state.id, identity);
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

export function resolveExitIpThroughMihomo(
  listener: URL,
  signal: AbortSignal,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ExitIpIdentity | undefined> {
  return resolveExitIpWithProviders(listener, signal, timeoutMs);
}

async function resolveExitIpWithProviders(
  listener: URL,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ExitIpIdentity | undefined> {
  const providers = [
    { host: "ipinfo.io", name: "ipinfo", path: "/json" },
    { host: "ipapi.co", name: "ipapi", path: "/json/" },
    { host: "ifconfig.co", name: "ifconfig", path: "/json" },
  ] as const;
  return discoverExitIdentity(
    providers,
    (provider) =>
      requestJsonThroughMihomo(listener, provider.host, provider.path, signal, timeoutMs),
    Date.now,
  );
}

export async function discoverExitIdentity(
  providers: readonly { host: string; name: string; path: string }[],
  requestProvider: (provider: {
    host: string;
    name: string;
    path: string;
  }) => Promise<Record<string, unknown> | undefined>,
  now: () => number = Date.now,
): Promise<ExitIpIdentity | undefined> {
  for (const provider of providers) {
    const body = await requestProvider(provider);
    if (!body) continue;
    const ip = typeof body.ip === "string" ? body.ip : undefined;
    if (!ip || !isIpAddress(ip) || body.error) continue;
    const country =
      typeof body.country === "string"
        ? body.country
        : typeof body.country_code === "string"
          ? body.country_code
          : typeof body.country_iso === "string"
            ? body.country_iso
            : undefined;
    return {
      ...(typeof body.city === "string" ? { city: body.city } : {}),
      ...(country ? { country } : {}),
      ip,
      provider: provider.name,
      verifiedAt: now(),
    };
  }
  return undefined;
}

function requestJsonThroughMihomo(
  listener: URL,
  host: string,
  path: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const tunnel = request({
      host: listener.hostname,
      method: "CONNECT",
      path: `${host}:443`,
      port: Number(listener.port || 80),
      signal,
    });
    tunnel.setTimeout(timeoutMs, () => {
      tunnel.destroy();
      finish();
    });
    tunnel.once("error", () => finish());
    tunnel.on("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish();
        return;
      }
      if (head.length > 0) socket.unshift(head);
      const secureSocket = connectTls({ servername: host, socket });
      secureSocket.setTimeout(timeoutMs, () => secureSocket.destroy());
      secureSocket.once("error", () => finish());
      const agent = new HttpsAgent({ keepAlive: false });
      agent.createConnection = () => secureSocket;
      const probe = requestHttps(
        {
          agent,
          headers: { accept: "application/json", host },
          hostname: host,
          path,
        },
        (exitResponse) => {
          const chunks: Buffer[] = [];
          exitResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          exitResponse.once("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                string,
                unknown
              >;
              finish(exitResponse.statusCode === 200 ? body : undefined);
            } catch {
              finish();
            }
          });
        },
      );
      probe.setTimeout(timeoutMs, () => probe.destroy());
      probe.once("error", () => finish());
      probe.end();
    });
    tunnel.end();
  });
}

function isIpAddress(value: string): boolean {
  return isIP(value) !== 0;
}

class ConcurrencyLimiter {
  #active = 0;
  readonly #limit: number;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
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
