import type { NodeHealthStatus } from "./health.js";

export interface SchedulerCandidate {
  activeConnections: number;
  consecutiveFailures: number;
  ewmaLatencyMs: number;
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
  currentWeight: number;
  healthStatus: NodeHealthStatus;
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
  #states: CandidateState[] = [];

  constructor(candidates: readonly SchedulerCandidate[] = []) {
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
          currentWeight: 0,
          healthStatus: candidate.healthy ? "healthy" : "cooldown",
          leasedConnections: 0,
          onDrained: undefined,
        };
      }
      existing.candidate = {
        ...candidate,
        consecutiveFailures: existing.candidate.consecutiveFailures,
        ewmaLatencyMs: existing.candidate.ewmaLatencyMs,
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
        candidate.healthy &&
        candidate.manualWeight > 0 &&
        candidate.successRate > 0,
    );
    if (eligible.length === 0) {
      return undefined;
    }

    const rawWeights = eligible.map(effectiveWeight);
    const highestWeight = Math.max(...rawWeights);
    const weights = rawWeights.map((weight) =>
      Math.max(1, Math.round((weight / highestWeight) * 10)),
    );
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    for (const [index, state] of eligible.entries()) {
      state.currentWeight += weights[index] ?? 0;
    }
    const selected = eligible.reduce((best, state) =>
      state.currentWeight > best.currentWeight ? state : best,
    );
    selected.currentWeight -= totalWeight;
    return lease(selected);
  }

  acquireById(id: string): SchedulerLease | undefined {
    const state = this.#states.find(({ candidate }) => candidate.id === id);
    if (
      !state?.candidate.healthy ||
      state.candidate.manualWeight <= 0 ||
      state.candidate.successRate <= 0
    ) {
      return undefined;
    }
    return lease(state);
  }

  acquireBySelector(selector: string): SchedulerLease | undefined {
    const state = this.#states.find(
      ({ candidate }) =>
        candidate.id === selector || (candidate.selectors ?? []).includes(selector),
    );
    if (
      !state?.candidate.healthy ||
      state.candidate.manualWeight <= 0 ||
      state.candidate.successRate <= 0
    ) {
      return undefined;
    }
    return lease(state);
  }

  hasCandidate(id: string): boolean {
    return this.#states.some(({ candidate }) => candidate.id === id);
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
      healthy: healthStatus === "healthy" || healthStatus === "degraded",
    };
    return true;
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

function effectiveWeight(state: CandidateState): number {
  const { candidate } = state;
  const load = candidate.activeConnections + state.leasedConnections;
  return (
    (candidate.manualWeight * candidate.successRate) /
    (Math.max(1, candidate.ewmaLatencyMs) * (candidate.consecutiveFailures + 1) * (load + 1))
  );
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
