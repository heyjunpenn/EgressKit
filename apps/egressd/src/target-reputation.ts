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

export class TargetReputation {
  readonly #entries = new Map<string, Map<string, number>>();
  readonly #key = randomBytes(32);
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
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
    const expiresAt = this.#now() + ttlMs;
    const entries = this.#entries.get(digest) ?? new Map<string, number>();
    entries.set(feedback.nodeId, expiresAt);
    this.#entries.set(digest, entries);
    return { expiresAt, nodeId: feedback.nodeId, status: "recorded" };
  }

  excludedNodeIds(target: string): ReadonlySet<string> {
    const digest = this.#digest(target);
    const entries = this.#entries.get(digest);
    if (!entries) return new Set();
    const now = this.#now();
    for (const [nodeId, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(nodeId);
    }
    if (entries.size === 0) this.#entries.delete(digest);
    return new Set(entries.keys());
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
