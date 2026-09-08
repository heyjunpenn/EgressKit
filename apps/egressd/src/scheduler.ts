export interface SchedulerCandidate {
  activeConnections: number;
  consecutiveFailures: number;
  ewmaLatencyMs: number;
  healthy: boolean;
  id: string;
  listener: URL;
  manualWeight: number;
  selectors?: readonly string[];
  successRate: number;
}

export type SchedulerSignals = Omit<SchedulerCandidate, "id" | "listener" | "selectors">;

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
): SchedulerCandidate {
  return { id, listener, selectors, ...signals };
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
  leasedConnections: number;
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
  #states: CandidateState[] = [];

  constructor(candidates: readonly SchedulerCandidate[] = []) {
    this.replaceCandidates(candidates);
  }

  replaceCandidates(candidates: readonly SchedulerCandidate[]): void {
    validateSelectorUniqueness(candidates);
    this.#states = candidates.map((candidate) => {
      validateCandidate(candidate);
      return { candidate, currentWeight: 0, leasedConnections: 0 };
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
      }
    },
  };
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
