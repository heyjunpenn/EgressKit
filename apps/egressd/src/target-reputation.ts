import { createHmac, randomBytes } from "node:crypto";

export type TargetFeedbackOutcome = 403 | 429 | "risk";

export interface TargetFeedback {
  nodeId: string;
  outcome: TargetFeedbackOutcome | number | string;
  target: string;
  ttlMs?: number;
}

export interface TargetFeedbackResult {
  expiresAt: number;
  nodeId: string;
  status: "recorded";
}

const DEFAULT_TTL_MS = 5 * 60_000;
const MAXIMUM_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAXIMUM_ENTRIES = 10_000;

interface Deadline {
  digest: string;
  expiresAt: number;
  nodeId: string;
}

export class TargetReputation {
  readonly #deadlines: Deadline[] = [];
  readonly #entries = new Map<string, Map<string, number>>();
  readonly #key = randomBytes(32);
  readonly #maximumEntries: number;
  readonly #now: () => number;
  #size = 0;

  constructor(options: { maximumEntries?: number; now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    if (!Number.isSafeInteger(this.#maximumEntries) || this.#maximumEntries < 1) {
      throw new Error("maximumEntries must be a positive safe integer");
    }
  }

  record(feedback: TargetFeedback): TargetFeedbackResult {
    if (feedback.outcome !== 403 && feedback.outcome !== 429 && feedback.outcome !== "risk") {
      throw new TargetFeedbackError("outcome must be 403, 429, or risk");
    }
    const ttlMs = feedback.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAXIMUM_TTL_MS) {
      throw new TargetFeedbackError(`ttlMs must be between 1 and ${MAXIMUM_TTL_MS}`);
    }
    if (!feedback.nodeId) {
      throw new TargetFeedbackError("nodeId is required");
    }
    const digest = this.#digest(feedback.target);
    const now = this.#now();
    this.#pruneExpired(now);
    const expiresAt = now + ttlMs;
    const entries = this.#entries.get(digest) ?? new Map<string, number>();
    if (!entries.has(feedback.nodeId)) {
      if (this.#size >= this.#maximumEntries) this.#evictSoonest();
      this.#size += 1;
    }
    entries.set(feedback.nodeId, expiresAt);
    this.#entries.set(digest, entries);
    this.#pushDeadline({ digest, expiresAt, nodeId: feedback.nodeId });
    if (this.#deadlines.length > this.#maximumEntries * 2) this.#rebuildDeadlines();
    return { expiresAt, nodeId: feedback.nodeId, status: "recorded" };
  }

  excludedNodeIds(target: string): ReadonlySet<string> {
    this.#pruneExpired(this.#now());
    const digest = this.#digest(target);
    const entries = this.#entries.get(digest);
    if (!entries) return new Set();
    return new Set(entries.keys());
  }

  #delete(deadline: Deadline): boolean {
    const entries = this.#entries.get(deadline.digest);
    if (entries?.get(deadline.nodeId) !== deadline.expiresAt) return false;
    entries.delete(deadline.nodeId);
    this.#size -= 1;
    if (entries.size === 0) this.#entries.delete(deadline.digest);
    return true;
  }

  #evictSoonest(): void {
    let deadline = this.#popDeadline();
    while (deadline && !this.#delete(deadline)) deadline = this.#popDeadline();
  }

  #popDeadline(): Deadline | undefined {
    const first = this.#deadlines[0];
    const last = this.#deadlines.pop();
    if (!first || !last) return first;
    if (this.#deadlines.length === 0) return first;
    this.#deadlines[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < this.#deadlines.length &&
        (this.#deadlines[left] as Deadline).expiresAt <
          (this.#deadlines[smallest] as Deadline).expiresAt
      ) {
        smallest = left;
      }
      if (
        right < this.#deadlines.length &&
        (this.#deadlines[right] as Deadline).expiresAt <
          (this.#deadlines[smallest] as Deadline).expiresAt
      ) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.#deadlines[index], this.#deadlines[smallest]] = [
        this.#deadlines[smallest] as Deadline,
        this.#deadlines[index] as Deadline,
      ];
      index = smallest;
    }
    return first;
  }

  #pruneExpired(now: number): void {
    while (this.#deadlines[0] && (this.#deadlines[0] as Deadline).expiresAt <= now) {
      this.#delete(this.#popDeadline() as Deadline);
    }
  }

  #pushDeadline(deadline: Deadline): void {
    this.#deadlines.push(deadline);
    let index = this.#deadlines.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (
        (this.#deadlines[parent] as Deadline).expiresAt <=
        (this.#deadlines[index] as Deadline).expiresAt
      ) {
        break;
      }
      [this.#deadlines[parent], this.#deadlines[index]] = [
        this.#deadlines[index] as Deadline,
        this.#deadlines[parent] as Deadline,
      ];
      index = parent;
    }
  }

  #rebuildDeadlines(): void {
    this.#deadlines.length = 0;
    for (const [digest, entries] of this.#entries) {
      for (const [nodeId, expiresAt] of entries) {
        this.#pushDeadline({ digest, expiresAt, nodeId });
      }
    }
  }

  #digest(target: string): string {
    const trimmed = target.trim();
    if (!trimmed) throw new TargetFeedbackError("target is required");
    let hostname: string;
    try {
      hostname = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
    } catch {
      throw new TargetFeedbackError("target must be a URL, host, or authority");
    }
    if (!hostname) throw new TargetFeedbackError("target must include a hostname");
    return createHmac("sha256", this.#key).update(hostname.toLowerCase()).digest("hex");
  }
}

export class TargetFeedbackError extends Error {}
