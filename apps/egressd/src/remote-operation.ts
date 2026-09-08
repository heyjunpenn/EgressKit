import { parse } from "yaml";

import type { ControlState, OperationProcessingStage, SubscriptionIdentity } from "./state.js";
import { type ImportedVlessRevision, importLocalVlessYaml } from "./subscription.js";

const MAXIMUM_SUBSCRIPTION_BYTES = 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export interface RemoteOperationRunnerOptions {
  activateRevision(
    revision: ImportedVlessRevision,
    subscription: SubscriptionIdentity,
    checking: () => void,
  ): Promise<void>;
  fetchSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  fetchTimeoutMs?: number;
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
      const source = await this.#download(subscription.locator);
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

  async #download(locator: string): Promise<string> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new SafeOperationError("remote subscription request timed out")),
      this.#options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await (this.#options.fetchSubscription ?? fetch)(locator, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SafeOperationError(`remote subscription returned HTTP ${response.status}`);
      }
      return await readRemoteSubscription(response, controller);
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }
}

class SafeOperationError extends Error {}

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
