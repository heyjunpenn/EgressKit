import { parse } from "yaml";

import type { ControlState, OperationProcessingStage, SubscriptionIdentity } from "./state.js";
import { type ImportedVlessRevision, importLocalVlessYaml } from "./subscription.js";

const MAXIMUM_SUBSCRIPTION_BYTES = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAXIMUM_FETCH_ATTEMPTS = 3;
const MAXIMUM_RETRY_AFTER_MS = 60_000;
const RETRY_BACKOFF_MS = 1_000;

export interface RemoteOperationClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface RemoteOperationRunnerOptions {
  activateRevision(
    revision: ImportedVlessRevision,
    subscription: SubscriptionIdentity,
    checking: () => void,
  ): Promise<void>;
  fetchSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  fetchTimeoutMs?: number;
  clock?: RemoteOperationClock;
  state: ControlState;
}

export function validateRemoteSubscriptionTimeout(fetchTimeoutMs: number | undefined): void {
  if (fetchTimeoutMs !== undefined && (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0)) {
    throw new Error("remote subscription fetch timeout must be positive");
  }
}

export class RemoteOperationRunner {
  readonly #controllers = new Set<AbortController>();
  readonly #options: RemoteOperationRunnerOptions;
  readonly #shutdownController = new AbortController();
  #queue = Promise.resolve();
  #shuttingDown = false;

  constructor(options: RemoteOperationRunnerOptions) {
    validateRemoteSubscriptionTimeout(options.fetchTimeoutMs);
    this.#options = options;
  }

  enqueue(operationId: string, subscriptionId: string): void {
    setImmediate(() => {
      this.#queue = this.#queue
        .then(() => this.#process(operationId, subscriptionId))
        .catch(() => undefined);
    });
  }

  close(): void {
    this.#shuttingDown = true;
    this.#shutdownController.abort();
    for (const controller of this.#controllers) {
      controller.abort();
    }
  }

  async #process(operationId: string, subscriptionId: string): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    let stage: OperationProcessingStage = "queued";
    try {
      const subscription = this.#options.state.getSubscription(subscriptionId);
      if (subscription?.kind !== "remote") {
        throw new Error(`remote subscription not found: ${subscriptionId}`);
      }
      stage = "fetching";
      this.#options.state.transitionOperation(operationId, stage);
      const source = await this.#downloadWithRetries(subscription.locator);
      if (this.#shuttingDown) {
        return;
      }
      stage = "parsing";
      this.#options.state.transitionOperation(operationId, stage);
      parse(source);
      stage = "validating";
      this.#options.state.transitionOperation(operationId, stage);
      const revision = importLocalVlessYaml(source, { firstListenerPort: 20_000 });
      if (revision.nodes.length === 0) {
        throw new Error("subscription contains no VLESS nodes");
      }
      stage = "applying";
      this.#options.state.transitionOperation(operationId, stage);
      await this.#options.activateRevision(revision, subscription, () => {
        if (!this.#shuttingDown) {
          stage = "checking";
          this.#options.state.transitionOperation(operationId, stage);
        }
      });
      if (this.#shuttingDown) {
        return;
      }
      this.#options.state.saveActiveRevision({ imported: revision, source: subscription });
      this.#options.state.transitionOperation(operationId, "succeeded");
    } catch (error) {
      if (!this.#shuttingDown) {
        this.#options.state.failOperation(operationId, stage, operationFailureReason(stage, error));
      }
    }
  }

  async #downloadWithRetries(locator: string): Promise<string> {
    for (let attempt = 0; attempt < MAXIMUM_FETCH_ATTEMPTS; attempt += 1) {
      try {
        return await this.#download(locator);
      } catch (error) {
        if (
          this.#shuttingDown ||
          !(error instanceof RetryableOperationError) ||
          attempt === MAXIMUM_FETCH_ATTEMPTS - 1
        ) {
          throw error;
        }
        const delay = error.retryAfterMs ?? RETRY_BACKOFF_MS * 2 ** attempt;
        await (this.#options.clock ?? systemClock).sleep(delay, this.#shutdownController.signal);
      }
    }
    throw new Error("remote subscription retry limit is invalid");
  }

  async #download(locator: string): Promise<string> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new RetryableOperationError("remote subscription request timed out")),
      this.#options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await (this.#options.fetchSubscription ?? fetch)(locator, {
        signal: controller.signal,
      });
      if (!response.ok) {
        const reason = `remote subscription returned HTTP ${response.status}`;
        const retryAfter =
          response.status === 429
            ? retryAfterMilliseconds(
                response.headers.get("retry-after"),
                (this.#options.clock ?? systemClock).now(),
              )
            : undefined;
        await cancelResponseBody(response);
        if (isRetryableStatus(response.status)) {
          throw new RetryableOperationError(reason, retryAfter);
        }
        throw new SafeOperationError(reason);
      }
      return await readRemoteSubscription(response, controller);
    } catch (error) {
      if (error instanceof SafeOperationError) {
        throw error;
      }
      if (controller.signal.reason instanceof SafeOperationError) {
        throw controller.signal.reason;
      }
      throw new RetryableOperationError("remote subscription request failed");
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }
}

class SafeOperationError extends Error {}

class RetryableOperationError extends SafeOperationError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const systemClock: RemoteOperationClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    }),
};

function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request timeout or peer may already have closed the response stream.
  }
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : undefined;
  const milliseconds =
    seconds === undefined ? Date.parse(value) - now : Math.min(seconds * 1_000, Number.MAX_VALUE);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAXIMUM_RETRY_AFTER_MS) {
    return undefined;
  }
  return milliseconds;
}

function operationFailureReason(stage: OperationProcessingStage, error: unknown): string {
  if (error instanceof SafeOperationError) {
    return error.message;
  }
  switch (stage) {
    case "queued":
      return "remote operation could not start";
    case "fetching":
      return "remote subscription request failed";
    case "parsing":
      return "remote subscription is not valid YAML";
    case "validating":
      return "remote subscription failed validation";
    case "applying":
      return "Mihomo runtime rejected the subscription";
    case "checking":
      return "Mihomo listener readiness check failed";
  }
}

async function readRemoteSubscription(
  response: Response,
  controller: AbortController,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAXIMUM_SUBSCRIPTION_BYTES) {
        await reader.cancel();
        controller.abort();
        throw new SafeOperationError("remote subscription exceeds 1 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  ).toString("utf8");
}
