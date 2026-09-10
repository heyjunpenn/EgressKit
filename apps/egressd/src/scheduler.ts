import type { NodeHealthStatus } from "./health.js";

export interface SchedulerCandidate {
  activeConnections: number;
  consecutiveFailures: number;
  ewmaLatencyMs: number;
  exitIp?: string;
  generation: string;
  healthy: boolean;
  id: string;
  listener: URL;
  manualWeight: number;
  selectors?: readonly string[];
  successRate: number;
}

export type SchedulerSignals = Omit<
  SchedulerCandidate,
  "generation" | "id" | "listener" | "selectors"
>;

const DEFAULT_SCHEDULER_SIGNALS: SchedulerSignals = {
  activeConnections: 0,
  consecutiveFailures: 0,
  ewmaLatencyMs: 1,
  healthy: true,
  manualWeight: 1,
  successRate: 1,
};

export function createSchedulerCandidate(
  id: string,
  listener: URL,
  signals: SchedulerSignals = DEFAULT_SCHEDULER_SIGNALS,
  selectors: readonly string[] = [],
  generation = listener.href,
): SchedulerCandidate {
  return { generation, id, listener, selectors, ...signals };
}

export interface SchedulerLease {
  candidate: SchedulerCandidate;
  reportConnectionFailure(): void;
  reportConnectionSuccess(latencyMs: number): void;
  release(): void;
}

interface CandidateState {
  candidate: SchedulerCandidate;
  healthStatus: NodeHealthStatus;
  lastSelectedSequence: number;
  leasedConnections: number;
  onDrained: ((candidate: SchedulerCandidate) => void) | undefined;
}

export function validateSelectorUniqueness(
  candidates: readonly Pick<SchedulerCandidate, "id" | "selectors">[],
  reservedSelectors: readonly string[] = [],
): void {
  const selectors = new Set(reservedSelectors);
  if (selectors.size !== reservedSelectors.length) {
    throw new Error("duplicate scheduler selector");
  }
  for (const candidate of candidates) {
    for (const selector of [candidate.id, ...(candidate.selectors ?? [])]) {
      if (selectors.has(selector)) {
        throw new Error(`duplicate scheduler selector: ${selector}`);
      }
      selectors.add(selector);
    }
  }
}

export class RotateScheduler {
  readonly #drainingStates = new Set<CandidateState>();
  readonly #requireExitIdentity: boolean;
  readonly #lastSelectedByExitIp = new Map<string, number>();
  #selectionSequence = 0;
  #states: CandidateState[] = [];

  constructor(
    candidates: readonly SchedulerCandidate[] = [],
    options: { requireExitIdentity?: boolean } = {},
  ) {
    this.#requireExitIdentity = options.requireExitIdentity ?? false;
    this.replaceCandidates(candidates);
  }

  replaceCandidates(
    candidates: readonly SchedulerCandidate[],
    onDrained?: (candidate: SchedulerCandidate) => void,
  ): void {
    validateSelectorUniqueness(candidates);
    for (const candidate of candidates) {
      validateCandidate(candidate);
    }
    const previous = new Map(this.#states.map((state) => [candidateKey(state.candidate), state]));
    const nextKeys = new Set(candidates.map(candidateKey));
    for (const state of this.#states) {
      if (!nextKeys.has(candidateKey(state.candidate))) {
        if (state.leasedConnections > 0) {
          this.#drainingStates.add(state);
        }
        beginDraining(state, (candidate) => {
          this.#drainingStates.delete(state);
          onDrained?.(candidate);
        });
      }
    }
    this.#states = candidates.map((candidate) => {
      const existing = previous.get(candidateKey(candidate));
      if (!existing) {
        return {
          candidate,
          healthStatus: candidate.healthy ? "available" : "unavailable",
          lastSelectedSequence: 0,
          leasedConnections: 0,
          onDrained: undefined,
        };
      }
      existing.candidate = {
        ...candidate,
        consecutiveFailures: existing.candidate.consecutiveFailures,
        ewmaLatencyMs: existing.candidate.ewmaLatencyMs,
        ...((candidate.exitIp ?? existing.candidate.exitIp)
          ? { exitIp: candidate.exitIp ?? existing.candidate.exitIp }
          : {}),
        healthy: existing.candidate.healthy,
        successRate: existing.candidate.successRate,
      };
      existing.onDrained = undefined;
      return existing;
    });
  }

  acquire(excludedIds: ReadonlySet<string> = new Set()): SchedulerLease | undefined {
    const eligible = this.#states.filter(
      ({ candidate }) =>
        !excludedIds.has(candidate.id) &&
        (!this.#requireExitIdentity || candidate.exitIp !== undefined) &&
        candidate.healthy &&
        candidate.manualWeight > 0 &&
        candidate.successRate > 0,
    );
    if (eligible.length === 0) {
      return undefined;
    }

    const selected = this.#requireExitIdentity
      ? this.#selectByExitIp(eligible)
      : eligible.reduce((oldest, state) =>
          state.lastSelectedSequence < oldest.lastSelectedSequence ? state : oldest,
        );
    return this.#leaseSelected(selected);
  }

  acquireById(id: string): SchedulerLease | undefined {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (
      !state?.candidate.healthy ||
      (this.#requireExitIdentity && state.candidate.exitIp === undefined) ||
      state.candidate.manualWeight <= 0 ||
      state.candidate.successRate <= 0
    ) {
      return undefined;
    }
    return this.#leaseSelected(state);
  }

  acquireBySelector(
    selector: string,
    excludedIds: ReadonlySet<string> = new Set(),
  ): SchedulerLease | undefined {
    const selected = this.#states.find(
      ({ candidate }) =>
        candidate.id === selector || (candidate.selectors ?? []).includes(selector),
    );
    const state =
      this.#requireExitIdentity && selected?.candidate.exitIp
        ? this.#states
            .filter(({ candidate }) => candidate.exitIp === selected.candidate.exitIp)
            .filter(({ candidate }) => !excludedIds.has(candidate.id))
            .filter(({ candidate }) => this.#isEligible(candidate))
            .reduce<CandidateState | undefined>(
              (oldest, candidate) =>
                !oldest || candidate.lastSelectedSequence < oldest.lastSelectedSequence
                  ? candidate
                  : oldest,
              undefined,
            )
        : selected && !excludedIds.has(selected.candidate.id)
          ? selected
          : undefined;
    if (
      !state?.candidate.healthy ||
      (this.#requireExitIdentity && state.candidate.exitIp === undefined) ||
      state.candidate.manualWeight <= 0 ||
      state.candidate.successRate <= 0
    ) {
      return undefined;
    }
    return this.#leaseSelected(state);
  }

  hasCandidate(id: string): boolean {
    return this.#states.some(({ candidate }) => candidate.id === id);
  }

  hasSchedulableCandidate(): boolean {
    return this.#states.some(
      ({ candidate }) =>
        (!this.#requireExitIdentity || candidate.exitIp !== undefined) &&
        candidate.healthy &&
        candidate.manualWeight > 0 &&
        candidate.successRate > 0,
    );
  }

  snapshot(): readonly SchedulerCandidate[] {
    return this.#states.map(({ candidate }) => ({ ...candidate }));
  }

  drainingCount(): number {
    return this.#drainingStates.size;
  }

  healthStatus(id: string): NodeHealthStatus | undefined {
    return this.#states.find(({ candidate }) => candidate.id === id)?.healthStatus;
  }

  reportHealthCheck(id: string, succeeded: boolean): boolean {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (!state) {
      return false;
    }
    state.candidate = succeeded
      ? {
          ...state.candidate,
          consecutiveFailures: 0,
          successRate: state.candidate.successRate * 0.8 + 0.2,
        }
      : {
          ...state.candidate,
          consecutiveFailures: state.candidate.consecutiveFailures + 1,
          successRate: state.candidate.successRate * 0.8,
        };
    return true;
  }

  setHealthStatus(id: string, healthStatus: NodeHealthStatus): boolean {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (!state) {
      return false;
    }
    state.healthStatus = healthStatus;
    state.candidate = {
      ...state.candidate,
      healthy: healthStatus === "available",
    };
    return true;
  }

  setManualEnabled(id: string, enabled: boolean): boolean {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (!state) {
      return false;
    }
    state.candidate = {
      ...state.candidate,
      manualWeight: enabled ? 1 : 0,
    };
    return true;
  }

  setExitIp(id: string, exitIp: string): boolean {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (!state) return false;
    state.candidate = { ...state.candidate, exitIp };
    return true;
  }

  clearExitIp(id: string): boolean {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (!state) return false;
    const { exitIp: _exitIp, ...candidate } = state.candidate;
    state.candidate = candidate;
    return true;
  }

  acquireByExitIp(
    exitIp: string,
    excludedIds: ReadonlySet<string> = new Set(),
  ): SchedulerLease | undefined {
    const eligible = this.#states.filter(
      ({ candidate }) =>
        candidate.exitIp === exitIp &&
        !excludedIds.has(candidate.id) &&
        this.#isEligible(candidate),
    );
    if (eligible.length === 0) return undefined;
    const selected = eligible.reduce((oldest, state) =>
      state.lastSelectedSequence < oldest.lastSelectedSequence ? state : oldest,
    );
    return this.#leaseSelected(selected);
  }

  setSelectors(id: string, selectors: readonly string[]): boolean {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (!state) {
      return false;
    }
    const candidates = this.#states.map(({ candidate }) =>
      candidate.id === id ? { ...candidate, selectors } : candidate,
    );
    validateSelectorUniqueness(candidates);
    state.candidate = { ...state.candidate, selectors };
    return true;
  }

  #leaseSelected(state: CandidateState): SchedulerLease {
    this.#selectionSequence += 1;
    state.lastSelectedSequence = this.#selectionSequence;
    if (state.candidate.exitIp) {
      this.#lastSelectedByExitIp.set(state.candidate.exitIp, this.#selectionSequence);
    }
    return lease(state);
  }

  #isEligible(candidate: SchedulerCandidate): boolean {
    return (
      (!this.#requireExitIdentity || candidate.exitIp !== undefined) &&
      candidate.healthy &&
      candidate.manualWeight > 0 &&
      candidate.successRate > 0
    );
  }

  #selectByExitIp(eligible: CandidateState[]): CandidateState {
    const oldestIp = [
      ...new Set(eligible.map(({ candidate }) => candidate.exitIp as string)),
    ].reduce((oldest, ip) =>
      (this.#lastSelectedByExitIp.get(ip) ?? 0) < (this.#lastSelectedByExitIp.get(oldest) ?? 0)
        ? ip
        : oldest,
    );
    return eligible
      .filter(({ candidate }) => candidate.exitIp === oldestIp)
      .reduce((oldest, state) =>
        state.lastSelectedSequence < oldest.lastSelectedSequence ? state : oldest,
      );
  }
}

function lease(state: CandidateState): SchedulerLease {
  state.leasedConnections += 1;
  let released = false;
  let outcomeReported = false;
  return {
    candidate: state.candidate,
    reportConnectionFailure: () => {
      if (outcomeReported) {
        return;
      }
      outcomeReported = true;
      state.candidate = {
        ...state.candidate,
        consecutiveFailures: state.candidate.consecutiveFailures + 1,
        successRate: state.candidate.successRate * 0.8,
      };
    },
    reportConnectionSuccess: (latencyMs) => {
      if (outcomeReported) {
        return;
      }
      outcomeReported = true;
      state.candidate = {
        ...state.candidate,
        consecutiveFailures: 0,
        ewmaLatencyMs: state.candidate.ewmaLatencyMs * 0.8 + latencyMs * 0.2,
        successRate: state.candidate.successRate * 0.8 + 0.2,
      };
    },
    release: () => {
      if (!released) {
        released = true;
        state.leasedConnections -= 1;
        notifyIfDrained(state);
      }
    },
  };
}

function candidateKey(
  candidate: Pick<SchedulerCandidate, "generation" | "id" | "listener">,
): string {
  return `${candidate.id}\0${candidate.generation}\0${candidate.listener.href}`;
}

function beginDraining(
  state: CandidateState,
  onDrained: ((candidate: SchedulerCandidate) => void) | undefined,
): void {
  state.onDrained = onDrained;
  notifyIfDrained(state);
}

function notifyIfDrained(state: CandidateState): void {
  if (state.leasedConnections !== 0 || !state.onDrained) {
    return;
  }
  const onDrained = state.onDrained;
  state.onDrained = undefined;
  onDrained(state.candidate);
}

function validateCandidate(candidate: SchedulerCandidate): void {
  if (!candidate.id) {
    throw new Error("scheduler candidate id must not be empty");
  }
  for (const [field, value] of [
    ["activeConnections", candidate.activeConnections],
    ["consecutiveFailures", candidate.consecutiveFailures],
    ["ewmaLatencyMs", candidate.ewmaLatencyMs],
    ["manualWeight", candidate.manualWeight],
    ["successRate", candidate.successRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`scheduler candidate ${field} must be a non-negative finite number`);
    }
  }
  if (candidate.successRate > 1) {
    throw new Error("scheduler candidate successRate must be between 0 and 1");
  }
}
