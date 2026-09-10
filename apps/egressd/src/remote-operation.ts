import { execFile } from "node:child_process";
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
  ): Promise<ImportedVlessRevision>;
  fetchSubscription?: (
    url: string,
    options: { headers: HeadersInit; signal: AbortSignal },
  ) => Promise<Response>;
  fetchTimeoutMs?: number;
  clock?: RemoteOperationClock;
  minimumNodes?: number;
  onSubscriptionActivated?: () => void;
  onLifecycle?: (event: {
    operationId: string;
    stage: OperationProcessingStage;
    status: "failed" | "running" | "succeeded";
  }) => void;
  runControlPlaneOperation?<Result>(operation: () => Promise<Result> | Result): Promise<Result>;
  state: ControlState;
  wgetSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<string>;
}

export function validateRemoteSubscriptionTimeout(fetchTimeoutMs: number | undefined): void {
  if (fetchTimeoutMs !== undefined && (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs <= 0)) {
    throw new Error("remote subscription fetch timeout must be positive");
  }
}

export function validateMinimumSubscriptionNodes(minimumNodes: number | undefined): void {
  if (minimumNodes !== undefined && (!Number.isInteger(minimumNodes) || minimumNodes < 1)) {
    throw new Error("minimum subscription nodes must be a positive integer");
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
    validateMinimumSubscriptionNodes(options.minimumNodes);
    this.#options = options;
  }

  enqueue(operationId: string, subscriptionId: string): void {
    if (this.#shuttingDown) {
      return;
    }
    setImmediate(() => {
      if (this.#shuttingDown) {
        return;
      }
      this.#queue = this.#queue
        .then(() => this.#process(operationId, subscriptionId))
        .catch(() => undefined);
    });
  }

  enqueueForce(operationId: string, subscriptionRevisionId: number): void {
    if (this.#shuttingDown) {
      return;
    }
    setImmediate(() => {
      if (this.#shuttingDown) {
        return;
      }
      this.#queue = this.#queue
        .then(() => this.#processForce(operationId, subscriptionRevisionId))
        .catch(() => undefined);
    });
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    this.#shutdownController.abort();
    for (const controller of this.#controllers) {
      controller.abort();
    }
    await this.#queue;
  }

  async #process(operationId: string, subscriptionId: string): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    let stage: OperationProcessingStage = "queued";
    try {
      const operation = this.#options.state.getOperation(operationId);
      if (operation?.subscriptionRevisionId === undefined) {
        throw new Error(`subscription revision not found for operation: ${operationId}`);
      }
      const subscriptionRevisionId = operation.subscriptionRevisionId;
      const subscription = this.#options.state.getSubscription(subscriptionId);
      if (subscription?.kind !== "remote") {
        throw new Error(`remote subscription not found: ${subscriptionId}`);
      }
      stage = "fetching";
      this.#options.state.transitionOperation(operationId, stage);
      this.#options.onLifecycle?.({ operationId, stage, status: "running" });
      const source = await this.#downloadWithRetries(subscription.locator);
      this.#options.state.advanceRevision(subscriptionRevisionId, "downloaded");
      if (this.#shuttingDown) {
        return;
      }
      stage = "parsing";
      this.#options.state.transitionOperation(operationId, stage);
      this.#options.onLifecycle?.({ operationId, stage, status: "running" });
      parse(source);
      this.#options.state.advanceRevision(subscriptionRevisionId, "parsed");
      stage = "validating";
      this.#options.state.transitionOperation(operationId, stage);
      this.#options.onLifecycle?.({ operationId, stage, status: "running" });
      const revision = importLocalVlessYaml(source, { firstListenerPort: 20_000 });
      this.#options.state.saveValidatedRevision(subscriptionRevisionId, revision);
      const suspiciousReason = this.#suspiciousReason(revision, subscription.id);
      if (suspiciousReason) {
        this.#options.state.markRevisionSuspicious(
          subscriptionRevisionId,
          operationId,
          suspiciousReason,
        );
        return;
      }
      await this.#apply(operationId, subscriptionRevisionId, revision, subscription, (next) => {
        stage = next;
      });
      this.#options.onLifecycle?.({ operationId, stage, status: "succeeded" });
    } catch (error) {
      if (!this.#shuttingDown) {
        this.#options.state.failOperation(operationId, stage, operationFailureReason(stage, error));
        this.#options.onLifecycle?.({ operationId, stage, status: "failed" });
      }
    }
  }

  async #processForce(operationId: string, subscriptionRevisionId: number): Promise<void> {
    let stage: OperationProcessingStage = "queued";
    try {
      const revision = this.#options.state.getRevision(subscriptionRevisionId);
      if (
        !revision?.imported ||
        !revision.suspiciousReason ||
        !["suspicious", "accepted"].includes(revision.status) ||
        !revision.forcePending
      ) {
        throw new Error(`subscription revision is not pending force: ${subscriptionRevisionId}`);
      }
      const subscription = this.#options.state.getSubscription(revision.subscriptionId);
      if (subscription?.kind !== "remote") {
        throw new Error(`remote subscription not found: ${revision.subscriptionId}`);
      }
      await this.#apply(
        operationId,
        subscriptionRevisionId,
        revision.imported,
        subscription,
        (next) => {
          stage = next;
        },
      );
    } catch (error) {
      if (!this.#shuttingDown) {
        this.#options.state.failForceOperation(
          operationId,
          subscriptionRevisionId,
          stage,
          operationFailureReason(stage, error),
        );
      }
    }
  }

  async #apply(
    operationId: string,
    subscriptionRevisionId: number,
    revision: ImportedVlessRevision,
    subscription: SubscriptionIdentity,
    setStage: (stage: OperationProcessingStage) => void,
  ): Promise<void> {
    setStage("applying");
    this.#options.state.transitionOperation(operationId, "applying");
    this.#options.onLifecycle?.({ operationId, stage: "applying", status: "running" });
    const runControlPlaneOperation =
      this.#options.runControlPlaneOperation ?? runControlPlaneOperationDirectly;
    await runControlPlaneOperation(async () => {
      const activatedRevision = await this.#options.activateRevision(revision, subscription, () => {
        if (!this.#shuttingDown) {
          this.#options.state.markRevisionAccepted(subscriptionRevisionId, operationId);
          setStage("checking");
          this.#options.onLifecycle?.({ operationId, stage: "checking", status: "running" });
        }
      });
      if (this.#shuttingDown) {
        return;
      }
      this.#options.state.saveActiveRevision({
        imported: activatedRevision,
        operationId,
        source: subscription,
        subscriptionRevisionId,
      });
      this.#options.onSubscriptionActivated?.();
    });
  }

  #suspiciousReason(revision: ImportedVlessRevision, subscriptionId: string): string | undefined {
    const nodeCount = revision.nodes.length;
    if (nodeCount === 0) {
      return "subscription revision contains zero nodes";
    }
    const minimumNodes = this.#options.minimumNodes ?? 1;
    if (nodeCount < minimumNodes) {
      return `subscription revision contains ${nodeCount} nodes, below the minimum of ${minimumNodes}`;
    }
    const active = this.#options.state.loadActiveRevision();
    if (active?.source.id === subscriptionId && nodeCount < active.imported.nodes.length * 0.5) {
      return "subscription revision shrank by more than 50%";
    }
    return undefined;
  }

  async #downloadWithRetries(locator: string): Promise<string> {
    let fetchFailure: unknown;
    try {
      return await this.#downloadUsingFetchWithRetries(locator);
    } catch (error) {
      if (
        !(error instanceof SafeOperationError) ||
        error.message !== "remote subscription returned HTTP 403"
      ) {
        throw error;
      }
      fetchFailure = error;
    }
    try {
      return await this.#downloadWithWget(locator);
    } catch (wgetFailure) {
      throw new SafeOperationError(
        `remote subscription download failed with fetch and wget: ${operationFailureReason("fetching", wgetFailure)}`,
        { cause: fetchFailure },
      );
    }
  }

  async #downloadUsingFetchWithRetries(locator: string): Promise<string> {
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

  async #downloadWithWget(locator: string): Promise<string> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new SafeOperationError("remote subscription wget timed out")),
      this.#options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );
    try {
      const source = await (this.#options.wgetSubscription ?? wgetSubscription)(locator, {
        signal: controller.signal,
      });
      if (Buffer.byteLength(source) > MAXIMUM_SUBSCRIPTION_BYTES) {
        throw new SafeOperationError("remote subscription exceeds 1 MiB");
      }
      return source;
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
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
        headers: {
          accept: "application/yaml, text/yaml, text/plain, */*",
          "user-agent": "clash.meta",
        },
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

function wgetSubscription(url: string, { signal }: { signal: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "wget",
      [
        "--quiet",
        "--output-document=-",
        "--timeout=30",
        "--user-agent=clash.meta",
        "--header=Accept: application/yaml, text/yaml, text/plain, */*",
        url,
      ],
      { encoding: "utf8", maxBuffer: MAXIMUM_SUBSCRIPTION_BYTES + 1, signal },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function runControlPlaneOperationDirectly<Result>(
  operation: () => Promise<Result> | Result,
): Promise<Result> {
  return await operation();
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
