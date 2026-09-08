export interface SchedulerCandidate {
  activeConnections: number;
  consecutiveFailures: number;
  ewmaLatencyMs: number;
  healthy: boolean;
  id: string;
  listener: URL;
  manualWeight: number;
  successRate: number;
}

export type SchedulerSignals = Omit<SchedulerCandidate, "id" | "listener">;

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
): SchedulerCandidate {
  return { id, listener, ...signals };
}

export interface SchedulerLease {
  candidate: SchedulerCandidate;
  release(): void;
}

interface CandidateState {
  candidate: SchedulerCandidate;
  currentWeight: number;
  leasedConnections: number;
}

export class RotateScheduler {
  #states: CandidateState[] = [];

  constructor(candidates: readonly SchedulerCandidate[] = []) {
    this.replaceCandidates(candidates);
  }

  replaceCandidates(candidates: readonly SchedulerCandidate[]): void {
    const ids = new Set<string>();
    this.#states = candidates.map((candidate) => {
      validateCandidate(candidate);
      if (ids.has(candidate.id)) {
        throw new Error(`duplicate scheduler candidate: ${candidate.id}`);
      }
      ids.add(candidate.id);
      return { candidate, currentWeight: 0, leasedConnections: 0 };
    });
  }

  acquire(): SchedulerLease | undefined {
    const eligible = this.#states.filter(
      ({ candidate }) =>
        candidate.healthy && candidate.manualWeight > 0 && candidate.successRate > 0,
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
}

function lease(state: CandidateState): SchedulerLease {
  state.leasedConnections += 1;
  let released = false;
  return {
    candidate: state.candidate,
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
