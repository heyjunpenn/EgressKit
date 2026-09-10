import { request } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";

export type NodeHealthStatus = "available" | "unavailable";

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
  onExitIdentityCleared?: (id: string) => void;
  onProbeResult?: (id: string, succeeded: boolean) => void;
  onStatusChange?: (id: string, status: NodeHealthStatus) => void;
  probe?: HealthProbe;
  random?: () => number;
  successThreshold?: number;
  scheduledBatchSize?: number;
  unavailableAfterFailures?: number;
}

interface NodeHealthState extends NodeHealthSnapshot {
  epoch: number;
  generation: string;
  listener: URL;
  nextExitProbeAt: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export class NodeHealthController {
  readonly #exitProbeLimiter = new ConcurrencyLimiter(5);
  readonly #exitIpProbe: ExitIpProbe | undefined;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #onExitIdentity: ((id: string, identity: ExitIpIdentity) => void) | undefined;
  readonly #onExitIdentityCleared: ((id: string) => void) | undefined;
  readonly #onProbeResult: ((id: string, succeeded: boolean) => void) | undefined;
  readonly #onStatusChange: ((id: string, status: NodeHealthStatus) => void) | undefined;
  readonly #random: () => number;
  readonly #scheduledBatchSize: number;
  readonly #unavailableAfterFailures: number;
  #nextScheduledRunAt = 0;
  #scheduledCursor = 0;
  #states = new Map<string, NodeHealthState>();

  constructor(options: NodeHealthControllerOptions) {
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#jitterMs = options.jitterMs ?? 5_000;
    this.#exitIpProbe = options.exitIpProbe;
    this.#random = options.random ?? Math.random;
    this.#onExitIdentity = options.onExitIdentity;
    this.#onExitIdentityCleared = options.onExitIdentityCleared;
    this.#onProbeResult = options.onProbeResult;
    this.#onStatusChange = options.onStatusChange;
    this.#scheduledBatchSize = options.scheduledBatchSize ?? 10;
    this.#unavailableAfterFailures = options.unavailableAfterFailures ?? 10;
    validateOptions(options);
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
          status: "unavailable",
        });
        this.#onStatusChange?.(node.id, "unavailable");
      }
    }
    this.#states = next;
  }

  recordConnectionFailure(id: string, now = Date.now()): boolean {
    const state = this.#states.get(id);
    if (!state?.manuallyEnabled) {
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
    if (!state?.manuallyEnabled) {
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
    this.#onStatusChange?.(state.id, state.exitIp ? "available" : "unavailable");
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
      }) => ({
        ...snapshot,
        status: snapshot.exitIp ? "available" : "unavailable",
      }),
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
    const identity = await this.#exitProbeLimiter
      .run(() => exitIpProbe(state.listener, signal))
      .catch(() => undefined);
    if (
      !identity ||
      signal.aborted ||
      this.#states.get(id) !== state ||
      state.epoch !== epoch ||
      !state.manuallyEnabled
    ) {
      if (
        !signal.aborted &&
        state.manuallyEnabled &&
        this.#states.get(id) === state &&
        state.epoch === epoch
      ) {
        this.#onProbeResult?.(id, false);
        this.#applyFailure(state, Date.now());
      }
      return undefined;
    }
    this.#onProbeResult?.(id, true);
    this.#recordExitIdentity(state, identity);
    return identity;
  }

  async verifyAllExits(
    signal = new AbortController().signal,
  ): Promise<readonly { id: string; identity?: ExitIpIdentity }[]> {
    return Promise.all(
      [...this.#states.values()]
        .filter(({ manuallyEnabled }) => manuallyEnabled)
        .map(async ({ id }) => {
          const identity = await this.verifyExit(id, signal).catch(() => undefined);
          return identity ? { id, identity } : { id };
        }),
    );
  }

  restoreExitIdentity(id: string, identity: ExitIpIdentity): boolean {
    const state = this.#states.get(id);
    if (!state) return false;
    this.#recordExitIdentity(state, identity);
    return true;
  }

  async runDue(now = Date.now(), signal = new AbortController().signal): Promise<void> {
    if (now < this.#nextScheduledRunAt) return;
    const enabled = [...this.#states.values()].filter(({ manuallyEnabled }) => manuallyEnabled);
    if (enabled.length === 0) return;
    const due = Array.from(
      { length: Math.min(this.#scheduledBatchSize, enabled.length) },
      (_, offset) => enabled[(this.#scheduledCursor + offset) % enabled.length],
    ).filter((state): state is NodeHealthState => state !== undefined);
    this.#scheduledCursor = (this.#scheduledCursor + due.length) % enabled.length;
    this.#nextScheduledRunAt = now + this.#intervalMs + this.#nextJitter();
    await Promise.all(due.map(({ id }) => this.verifyExit(id, signal)));
  }

  #applyFailure(state: NodeHealthState, now: number): void {
    state.consecutiveFailures += 1;
    state.epoch += 1;
    state.nextProbeAt = now + this.#intervalMs;
    if (state.consecutiveFailures >= this.#unavailableAfterFailures && state.exitIp) {
      delete state.exitIp;
      delete state.exitLocation;
      delete state.exitProvider;
      delete state.exitVerifiedAt;
      this.#setStatus(state, "unavailable");
      this.#onExitIdentityCleared?.(state.id);
    }
  }

  #recordExitIdentity(state: NodeHealthState, identity: ExitIpIdentity): void {
    state.exitIp = identity.ip;
    state.exitProvider = identity.provider;
    state.exitVerifiedAt = identity.verifiedAt;
    state.nextExitProbeAt = Number.POSITIVE_INFINITY;
    state.consecutiveFailures = 0;
    state.cooldownCount = 0;
    const location = [identity.country, identity.city].filter(Boolean).join("-");
    if (location) state.exitLocation = location;
    this.#setStatus(state, "available");
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
    this.#onStatusChange?.(state.id, status);
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

function validateOptions(options: NodeHealthControllerOptions): void {
  if (options.healthUrls.length === 0) {
    throw new Error("at least one health URL is required");
  }
  for (const url of options.healthUrls) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("health URLs must use HTTP or HTTPS");
    }
  }
  for (const [name, value] of [
    ["exit check interval", options.intervalMs ?? DEFAULT_INTERVAL_MS],
    ["scheduled exit check batch size", options.scheduledBatchSize ?? 10],
    ["unavailable failure threshold", options.unavailableAfterFailures ?? 10],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if ((options.jitterMs ?? 5_000) < 0) {
    throw new Error("health jitter must not be negative");
  }
}
