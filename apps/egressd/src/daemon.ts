import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { redactSubscriptionUrl } from "./control-cli.js";
import { type HealthProbe, NodeHealthController, type NodeHealthSnapshot } from "./health.js";
import { MihomoCrashRecovery, type MihomoRecoveryClock } from "./mihomo-recovery.js";
import { isLoopbackHost, isLoopbackHttpUrl } from "./network.js";
import {
  authorizeProxyRequest,
  type ProxyAuthentication,
  type ProxyRoute,
  rejectConnectProxyAuthentication,
  rejectHttpProxyAuthentication,
} from "./proxy-auth.js";
import {
  type RemoteOperationClock,
  RemoteOperationRunner,
  validateMinimumSubscriptionNodes,
  validateRemoteSubscriptionTimeout,
} from "./remote-operation.js";
import {
  createSchedulerCandidate,
  RotateScheduler,
  type SchedulerLease,
  type SchedulerSignals,
  validateSelectorUniqueness,
} from "./scheduler.js";
import {
  type SessionBindingStore,
  SessionCapacityError,
  type SessionClock,
  SoftStickySessions,
} from "./session.js";
import {
  NodeAliasConflictError,
  NodeAliasTargetNotFoundError,
  nodeGeneration,
  openControlState,
  type PersistedNodeGeneration,
  type PreparedNodeRevision,
  RevisionForceConflictError,
} from "./state.js";
import { type ImportedVlessRevision, importLocalVlessYaml } from "./subscription.js";

export interface MihomoRuntime {
  apply(
    config: ImportedVlessRevision["mihomoConfig"],
    context: MihomoApplyContext,
  ): Promise<ReadonlyMap<string, URL>>;
  check(config: ImportedVlessRevision["mihomoConfig"]): Promise<void>;
  close?(): Promise<void>;
  onUnexpectedExit?(listener: () => void): () => void;
  removeListener(listener: URL): Promise<void>;
  restart?(signal: AbortSignal): Promise<void>;
}

export interface MihomoApplyContext {
  preserveListeners: readonly URL[];
}

export interface EgressdOptions {
  adminToken?: string;
  allowUnsafeUnauthenticatedProxy?: boolean;
  controlSocketPath?: string;
  checkMihomoListener?: (listener: URL) => Promise<void>;
  fetchSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  healthCheckConcurrency?: number;
  healthCheckIntervalMs?: number;
  healthCheckJitterMs?: number;
  healthCheckProbe?: HealthProbe;
  healthCheckSuccessThreshold?: number;
  healthCheckUrls?: readonly URL[];
  host: string;
  log?: (event: EgressdLogEvent) => void;
  mihomoListener?: URL;
  mihomoRecoveryClock?: MihomoRecoveryClock;
  mihomoRuntime?: MihomoRuntime;
  minimumSubscriptionNodes?: number;
  onConnectionOutcome?: (outcome: ConnectionOutcome) => void;
  port: number;
  portQuarantineMs?: number;
  preconnectAttempts?: number;
  preconnectTimeoutMs?: number;
  proxyAuthentication?: ProxyAuthentication;
  remoteSubscriptionTimeoutMs?: number;
  remoteOperationClock?: RemoteOperationClock;
  schedulerSignals?: ReadonlyMap<string, SchedulerSignals>;
  sessionAbsoluteTtlMs?: number;
  sessionBindingStore?: SessionBindingStore;
  sessionClock?: SessionClock;
  sessionIdleTimeoutMs?: number;
  sessionMaximumActiveSessions?: number;
  sessionMaximumConcurrentConnections?: number;
  stateDirectory?: string;
}

export interface ConnectionOutcome {
  latencyMs?: number;
  nodeId: string;
  result: "failure" | "success";
}

export interface EgressdLogEvent {
  event: "egressd.proxy_auth.disabled";
  exposure: "non-loopback";
  host: string;
  level: "warn";
}

export interface RunningEgressd {
  address: {
    host: string;
    port: number;
  };
  controlSocketPath?: string;
  close(): Promise<void>;
  healthSnapshot(): readonly NodeHealthSnapshot[];
  importLocalSubscription(source: string): Promise<ImportedVlessRevision>;
  setNodeEnabled(id: string, enabled: boolean): boolean;
}

interface RuntimeGeneration {
  generation: string;
  id: string;
  listener: URL;
  listenerPort: number;
}

interface RuntimeConfigurationState {
  active: "configured" | ImportedVlessRevision | undefined;
  candidate: ImportedVlessRevision | undefined;
  previous: "configured" | ImportedVlessRevision | undefined;
  status: "failed" | "not-ready" | "ready";
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeServerIfListening(server: Server | undefined): Promise<void> {
  return server?.listening ? closeServer(server) : Promise.resolve();
}

async function prepareControlSocketPath(path: string): Promise<void> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!before.isSocket()) {
    throw addressInUseError(path);
  }
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      reject(addressInUseError(path));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        resolve();
        return;
      }
      reject(error);
    });
  });
  const after = await lstat(path);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
    throw addressInUseError(path);
  }
  await rm(path);
}

function addressInUseError(path: string): Error {
  return Object.assign(new Error(`EADDRINUSE: control socket path is already in use: ${path}`), {
    code: "EADDRINUSE",
  });
}

export async function startEgressd(options: EgressdOptions): Promise<RunningEgressd> {
  validateRemoteSubscriptionTimeout(options.remoteSubscriptionTimeoutMs);
  validateMinimumSubscriptionNodes(options.minimumSubscriptionNodes);
  validatePreconnectAttempts(options.preconnectAttempts);
  validatePreconnectTimeout(options.preconnectTimeoutMs);
  if (
    (options.mihomoRuntime?.onUnexpectedExit === undefined) !==
    (options.mihomoRuntime?.restart === undefined)
  ) {
    throw new Error("Mihomo runtime recovery requires both onUnexpectedExit and restart");
  }
  if (options.proxyAuthentication === false && !isLoopbackHost(options.host)) {
    if (!options.allowUnsafeUnauthenticatedProxy) {
      throw new Error("refusing to disable proxy authentication on a non-loopback host");
    }
    const event: EgressdLogEvent = {
      event: "egressd.proxy_auth.disabled",
      exposure: "non-loopback",
      host: options.host,
      level: "warn",
    };
    (options.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`)))(event);
  }
  const scheduler = new RotateScheduler(
    options.mihomoListener
      ? [
          createSchedulerCandidate(
            "configured",
            options.mihomoListener,
            options.schedulerSignals?.get("configured"),
          ),
        ]
      : [],
  );
  const healthController = options.healthCheckUrls
    ? new NodeHealthController({
        ...(options.healthCheckConcurrency === undefined
          ? {}
          : { concurrency: options.healthCheckConcurrency }),
        healthUrls: options.healthCheckUrls,
        ...(options.healthCheckIntervalMs === undefined
          ? {}
          : { intervalMs: options.healthCheckIntervalMs }),
        ...(options.healthCheckJitterMs === undefined
          ? {}
          : { jitterMs: options.healthCheckJitterMs }),
        onProbeResult: (id, succeeded) => scheduler.reportHealthCheck(id, succeeded),
        onStatusChange: (id, status) => scheduler.setHealthStatus(id, status),
        ...(options.healthCheckProbe === undefined ? {} : { probe: options.healthCheckProbe }),
        ...(options.healthCheckSuccessThreshold === undefined
          ? {}
          : { successThreshold: options.healthCheckSuccessThreshold }),
      })
    : undefined;
  if (healthController) {
    healthController.replaceNodes(
      scheduler.snapshot().map(({ id, listener }) => ({ generation: "configured", id, listener })),
    );
  }
  const state = options.stateDirectory ? await openControlState(options.stateDirectory) : undefined;
  const closeRuntimeAndState = async () => {
    try {
      await options.mihomoRuntime?.close?.();
    } finally {
      await state?.close();
    }
  };
  const runtimeGenerations = new Map<string, RuntimeGeneration>();
  const retirementOperations = new Set<Promise<void>>();
  const runtimeConfiguration: RuntimeConfigurationState = {
    active: options.mihomoListener === undefined ? undefined : "configured",
    candidate: undefined,
    previous: undefined,
    status: options.mihomoListener === undefined ? "not-ready" : "ready",
  };
  let runtimeAvailable = true;
  const withControlPlaneLock = createAsyncLock();
  let softStickySessions: SoftStickySessions;
  try {
    if (state && options.mihomoRuntime) {
      for (const lease of state.listDrainingListenerLeases()) {
        await options.mihomoRuntime.removeListener(
          new URL(`http://127.0.0.1:${lease.listenerPort}`),
        );
        state.releaseNodeGeneration(
          lease.logicalId,
          lease.generation,
          lease.listenerPort,
          Date.now() + (options.portQuarantineMs ?? 60_000),
        );
      }
    }
    softStickySessions = new SoftStickySessions({
      ...(options.sessionAbsoluteTtlMs === undefined
        ? {}
        : { absoluteTtlMs: options.sessionAbsoluteTtlMs }),
      ...(options.sessionClock === undefined ? {} : { clock: options.sessionClock }),
      ...(options.sessionIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.sessionIdleTimeoutMs }),
      ...(options.sessionMaximumActiveSessions === undefined
        ? {}
        : { maximumActiveSessions: options.sessionMaximumActiveSessions }),
      ...(options.sessionMaximumConcurrentConnections === undefined
        ? {}
        : { maximumConcurrentConnections: options.sessionMaximumConcurrentConnections }),
      scheduler,
      ...(options.sessionBindingStore === undefined
        ? state === undefined
          ? {}
          : { store: state }
        : { store: options.sessionBindingStore }),
    });
  } catch (error) {
    await closeRuntimeAndState();
    throw error;
  }

  const acquireRoute = (route: ProxyRoute, excludedIds: ReadonlySet<string> = new Set()) => {
    if (runtimeConfiguration.status === "failed" || !runtimeAvailable) {
      return undefined;
    }
    if (route.mode === "rotate") {
      return scheduler.acquire(excludedIds);
    }
    if (route.mode === "sticky") {
      return softStickySessions.acquire(route.sessionKey, excludedIds);
    }
    if (route.mode === "strict") {
      return softStickySessions.acquireStrict(route.sessionKey);
    }
    if (route.mode === "node") {
      return scheduler.acquireBySelector(route.selector);
    }
    return "not-implemented" as const;
  };

  const acquirePreconnectedRoute = async (
    route: ProxyRoute,
    signal: AbortSignal,
    confirmConnection?: (socket: Socket) => Promise<void>,
  ): Promise<
    { latencyMs: number; lease: SchedulerLease; socket: Socket } | "not-implemented" | undefined
  > => {
    const attemptedIds = new Set<string>();
    const maximumAttempts = isFallbackRoute(route) ? (options.preconnectAttempts ?? 3) : 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const lease = acquireRoute(route, attemptedIds);
      if (lease === "not-implemented" || lease === undefined) {
        return lease;
      }
      const observedLease = observeConnectionOutcome(lease, (outcome) => {
        if (outcome.result === "failure") {
          healthController?.recordConnectionFailure(outcome.nodeId);
        } else {
          healthController?.recordConnectionSuccess(outcome.nodeId);
        }
        options.onConnectionOutcome?.(outcome);
      });
      attemptedIds.add(observedLease.candidate.id);
      const startedAt = Date.now();
      try {
        const socket = await connectMihomoListener(
          observedLease.candidate.listener,
          options.preconnectTimeoutMs ?? 10_000,
          signal,
        );
        try {
          await confirmConnection?.(socket);
        } catch (error) {
          socket.destroy();
          throw error;
        }
        return { lease: observedLease, latencyMs: Date.now() - startedAt, socket };
      } catch (error) {
        if (!(error instanceof ClientCancelledError)) {
          observedLease.reportConnectionFailure();
        }
        observedLease.release();
        if (error instanceof ClientCancelledError) {
          throw error;
        }
      }
    }
    return undefined;
  };

  const activateRevisionUnlocked = async (
    revision: ImportedVlessRevision,
    persistedNodes?: readonly PersistedNodeGeneration[],
    logicalIdPrefix = "local",
    checking?: () => void,
  ): Promise<ImportedVlessRevision> => {
    const runtime = options.mihomoRuntime;
    if (!runtime) {
      throw new Error("Mihomo runtime is not configured");
    }
    const prepared =
      persistedNodes === undefined
        ? (state?.prepareNodeRevision(logicalIdPrefix, revision) ??
          prepareTransientNodeRevision(logicalIdPrefix, revision))
        : preparePersistedNodeRevision(revision, persistedNodes);
    runtimeConfiguration.candidate = prepared.imported;
    runtimeConfiguration.previous = runtimeConfiguration.active;
    const identities = prepared.nodes.map(({ generation, listenerPort, logicalId: id, node }) => ({
      generation,
      id,
      listenerPort,
      node,
    }));
    let aliases = state?.getNodeAliases() ?? new Map<string, string>();
    validateSelectorUniqueness(
      identities.map(({ id }) => ({ id })),
      [...aliases.values()],
    );
    let listeners: ReadonlyMap<string, URL>;
    try {
      await runtime.check(prepared.imported.mihomoConfig);
      listeners = await applyRuntimeRevision(
        runtime,
        prepared.imported,
        runtimeGenerations,
        options.checkMihomoListener ?? checkListenerReady,
        checking,
      );
      aliases = state?.getNodeAliases() ?? aliases;
      validateSelectorUniqueness(
        identities.map(({ id }) => ({ id })),
        [...aliases.values()],
      );
      const activeRuntimeKeys = new Set(
        scheduler
          .snapshot()
          .map(({ generation, id, listener }) => generationKey(id, generation, listener)),
      );
      const candidates = identities.map(({ generation, id, node }) => {
        const alias = aliases.get(id);
        const listener = listeners.get(node.name) as URL;
        const key = generationKey(id, generation, listener);
        if (runtimeGenerations.has(key) && !activeRuntimeKeys.has(key)) {
          throw new Error(`Mihomo runtime reused a draining listener for ${node.name}`);
        }
        return createSchedulerCandidate(
          id,
          listener,
          options.schedulerSignals?.get(id),
          alias === undefined ? [] : [alias],
          generation,
        );
      });
      scheduler.replaceCandidates(candidates, (drained) => {
        const key = generationKey(drained.id, drained.generation, drained.listener);
        const retired = runtimeGenerations.get(key);
        if (!retired) {
          return;
        }
        let removal: Promise<void>;
        removal = runtime
          .removeListener(retired.listener)
          .then(() => {
            state?.releaseNodeGeneration(
              retired.id,
              retired.generation,
              retired.listenerPort,
              Date.now() + (options.portQuarantineMs ?? 60_000),
            );
            if (runtimeGenerations.get(key) === retired) {
              runtimeGenerations.delete(key);
            }
          })
          .catch(() => undefined)
          .finally(() => retirementOperations.delete(removal));
        retirementOperations.add(removal);
      });
    } catch (error) {
      runtimeConfiguration.candidate = undefined;
      const previous = runtimeConfiguration.previous;
      if (previous === "configured") {
        runtimeConfiguration.status = scheduler.snapshot().length === 0 ? "failed" : "ready";
        throw error;
      }
      if (!previous) {
        runtimeConfiguration.status = "failed";
        throw error;
      }
      try {
        await applyRuntimeRevision(
          runtime,
          previous,
          runtimeGenerations,
          options.checkMihomoListener ?? checkListenerReady,
        );
        runtimeConfiguration.status = "ready";
      } catch (rollbackError) {
        runtimeConfiguration.status = "failed";
        throw new Error(
          `runtime rollback failed after candidate rejection: ${errorMessage(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    const nextRuntimeGenerations = new Map<string, RuntimeGeneration>();
    for (const { generation, id, listenerPort, node } of identities) {
      const listener = listeners.get(node.name) as URL;
      nextRuntimeGenerations.set(generationKey(id, generation, listener), {
        generation,
        id,
        listener,
        listenerPort,
      });
    }
    for (const [key, generation] of nextRuntimeGenerations) {
      runtimeGenerations.set(key, generation);
    }
    healthController?.replaceNodes(
      identities.map(({ generation, id, node }) => ({
        generation,
        id,
        listener: listeners.get(node.name) as URL,
      })),
    );
    runtimeConfiguration.active = prepared.imported;
    runtimeConfiguration.candidate = undefined;
    runtimeConfiguration.status = "ready";
    return prepared.imported;
  };

  try {
    const restored = state?.loadActiveRevision();
    if (restored) {
      await withControlPlaneLock(() => activateRevisionUnlocked(restored.imported, restored.nodes));
    }
  } catch (error) {
    await closeRuntimeAndState();
    throw error;
  }

  const importLocalSubscription = async (source: string): Promise<ImportedVlessRevision> => {
    const revision = importLocalVlessYaml(source, { firstListenerPort: 20_000 });
    if (revision.nodes.length === 0) {
      throw new Error("subscription contains no VLESS nodes");
    }
    await withControlPlaneLock(async () => {
      const activated = await activateRevisionUnlocked(revision);
      state?.saveActiveRevision({
        imported: activated,
        source: { id: "local", kind: "local", locator: "inline" },
      });
    });
    return state?.loadActiveRevision()?.imported ?? revision;
  };

  let stopWatchingRuntime: () => void = () => undefined;
  let crashRecovery: MihomoCrashRecovery | undefined;
  const recoverableRuntime = options.mihomoRuntime;
  if (recoverableRuntime?.onUnexpectedExit && recoverableRuntime.restart) {
    crashRecovery = new MihomoCrashRecovery({
      ...(options.mihomoRecoveryClock === undefined ? {} : { clock: options.mihomoRecoveryClock }),
      onReady: () => {
        runtimeAvailable = true;
      },
      onUnavailable: () => {
        runtimeAvailable = false;
      },
      restart: (signal) =>
        withControlPlaneLock(async () => {
          if (signal.aborted) {
            throw signal.reason;
          }
          await recoverableRuntime.restart?.(signal);
          if (signal.aborted) {
            throw signal.reason;
          }
          for (const { listener } of scheduler.snapshot()) {
            if (signal.aborted) {
              throw signal.reason;
            }
            await (options.checkMihomoListener ?? checkListenerReady)(listener);
            if (signal.aborted) {
              throw signal.reason;
            }
          }
        }),
    });
    try {
      stopWatchingRuntime = recoverableRuntime.onUnexpectedExit(() =>
        crashRecovery?.unexpectedExit(),
      );
    } catch (error) {
      await crashRecovery.close();
      await closeRuntimeAndState();
      throw error;
    }
  }

  const remoteOperations = state
    ? new RemoteOperationRunner({
        activateRevision: (revision, subscription, checking) =>
          activateRevisionUnlocked(revision, undefined, subscription.id, checking),
        ...(options.fetchSubscription === undefined
          ? {}
          : { fetchSubscription: options.fetchSubscription }),
        ...(options.remoteSubscriptionTimeoutMs === undefined
          ? {}
          : { fetchTimeoutMs: options.remoteSubscriptionTimeoutMs }),
        ...(options.remoteOperationClock === undefined
          ? {}
          : { clock: options.remoteOperationClock }),
        ...(options.minimumSubscriptionNodes === undefined
          ? {}
          : { minimumNodes: options.minimumSubscriptionNodes }),
        runControlPlaneOperation: withControlPlaneLock,
        state,
      })
    : undefined;

  const createRequestHandler =
    (localControl: boolean) => (incoming: IncomingMessage, response: ServerResponse) => {
      if (localControl && !isAuthorizedAdmin(incoming, options.adminToken)) {
        rejectAdminAuthentication(response);
        return;
      }
      if (incoming.method === "GET" && incoming.url === "/live") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "live" }));
        return;
      }

      if (incoming.method === "GET" && incoming.url === "/ready") {
        const ready =
          runtimeAvailable &&
          runtimeConfiguration.status === "ready" &&
          scheduler.snapshot().length > 0;
        writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" });
        return;
      }

      if (incoming.method === "POST" && incoming.url === "/subscriptions/local") {
        if (
          !options.adminToken ||
          incoming.headers.authorization !== `Bearer ${options.adminToken}`
        ) {
          response.writeHead(401, { "www-authenticate": "Bearer" });
          response.end();
          return;
        }
        readBody(incoming)
          .then(importLocalSubscription)
          .then((revision) => {
            response.writeHead(201, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                nodes: revision.mihomoConfig.listeners.map((listener) => ({
                  name: listener.proxy,
                  listener: { host: listener.listen, port: listener.port },
                })),
              }),
            );
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const status = message.includes("runtime") || message.includes("listener") ? 503 : 422;
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: message }));
          });
        return;
      }

      if (incoming.method === "POST" && incoming.url === "/subscriptions/remote") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state) {
          writeJson(response, 503, { error: "durable control state is not configured" });
          return;
        }
        readBody(incoming)
          .then((body) => parseRemoteSubscriptionRequest(body))
          .then((url) => state.createRemoteSubscription(url))
          .then((created) => {
            writeJson(response, 202, {
              operationId: created.operationId,
              revisionId: created.subscriptionRevisionId,
              status: "queued",
              subscriptionId: created.subscriptionId,
            });
            remoteOperations?.enqueue(created.operationId, created.subscriptionId);
          })
          .catch((error: unknown) => {
            writeJson(response, 422, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }

      const subscriptionMatch = incoming.url?.match(/^\/subscriptions\/([^/]+)$/);
      if (incoming.method === "GET" && subscriptionMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        const subscription = state?.getSubscription(subscriptionMatch[1] as string);
        if (!subscription) {
          writeJson(response, 404, { error: "subscription not found" });
          return;
        }
        writeJson(response, 200, {
          kind: subscription.kind,
          subscriptionId: subscription.id,
          ...(subscription.kind === "remote"
            ? {
                url: localControl
                  ? subscription.locator
                  : redactSubscriptionUrl(subscription.locator),
              }
            : {}),
        });
        return;
      }

      const operationMatch = incoming.url?.match(/^\/operations\/([^/]+)$/);
      if (incoming.method === "GET" && operationMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        const operation = state?.getOperation(operationMatch[1] as string);
        if (!operation) {
          writeJson(response, 404, { error: "operation not found" });
          return;
        }
        writeJson(response, 200, {
          ...(operation.failure ? { failure: operation.failure } : {}),
          history: operation.history,
          operationId: operation.id,
          ...(operation.subscriptionRevisionId === undefined
            ? {}
            : { revisionId: operation.subscriptionRevisionId }),
          status: operation.status,
          subscriptionId: operation.subscriptionId,
        });
        return;
      }

      const revisionMatch = incoming.url?.match(/^\/revisions\/(\d+)$/);
      if (incoming.method === "GET" && revisionMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        const revision = state?.getRevision(Number(revisionMatch[1]));
        if (!revision) {
          writeJson(response, 404, { error: "revision not found" });
          return;
        }
        writeJson(response, 200, {
          forced: revision.forced,
          history: revision.history,
          nodeCount: revision.nodeCount,
          revisionId: revision.subscriptionRevisionId,
          status: revision.status,
          subscriptionId: revision.subscriptionId,
          ...(revision.suspiciousReason === undefined
            ? {}
            : { suspiciousReason: revision.suspiciousReason }),
        });
        return;
      }

      const nodeAliasMatch = incoming.url?.match(/^\/nodes\/([^/]+)\/alias$/);
      if (incoming.method === "PUT" && nodeAliasMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state) {
          writeJson(response, 503, { error: "durable control state is not configured" });
          return;
        }
        readBody(incoming)
          .then(parseNodeAliasRequest)
          .then((alias) =>
            withControlPlaneLock(() => {
              const logicalNodeId = decodeNodeLogicalId(nodeAliasMatch[1] as string);
              if (!scheduler.hasCandidate(logicalNodeId)) {
                throw new NodeAliasTargetNotFoundError(`active node not found: ${logicalNodeId}`);
              }
              state.saveNodeAlias(logicalNodeId, alias);
              if (!scheduler.setSelectors(logicalNodeId, [alias])) {
                throw new Error(`active node disappeared while saving alias: ${logicalNodeId}`);
              }
              writeJson(response, 200, { alias, nodeId: logicalNodeId });
            }),
          )
          .catch((error: unknown) => {
            const status =
              error instanceof NodeAliasConflictError
                ? 409
                : error instanceof NodeAliasTargetNotFoundError
                  ? 404
                  : error instanceof NodeAliasRequestError
                    ? 422
                    : 500;
            writeJson(response, status, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }

      const forceRevisionMatch = incoming.url?.match(/^\/revisions\/(\d+)\/force$/);
      if (incoming.method === "POST" && forceRevisionMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state || !remoteOperations) {
          writeJson(response, 503, { error: "durable control state is not configured" });
          return;
        }
        try {
          const operation = state.createForceOperation(Number(forceRevisionMatch[1]));
          writeJson(response, 202, {
            operationId: operation.id,
            revisionId: operation.subscriptionRevisionId,
            status: operation.status,
            subscriptionId: operation.subscriptionId,
          });
          remoteOperations.enqueueForce(operation.id, operation.subscriptionRevisionId as number);
        } catch (error) {
          writeJson(response, error instanceof RevisionForceConflictError ? 409 : 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      const refreshMatch = incoming.url?.match(/^\/subscriptions\/([^/]+)\/refresh$/);
      if (incoming.method === "POST" && refreshMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state) {
          writeJson(response, 503, { error: "durable control state is not configured" });
          return;
        }
        try {
          const operation = state.createRefreshOperation(refreshMatch[1] as string);
          writeJson(response, 202, {
            operationId: operation.id,
            revisionId: operation.subscriptionRevisionId,
            status: operation.status,
            subscriptionId: operation.subscriptionId,
          });
          remoteOperations?.enqueue(operation.id, operation.subscriptionId);
        } catch (error) {
          writeJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (localControl) {
        writeJson(response, 404, { error: "management route not found" });
        return;
      }

      const route = authorizeProxyRequest(
        incoming.headers["proxy-authorization"],
        options.proxyAuthentication,
      );
      if (route === undefined) {
        rejectHttpProxyAuthentication(response);
        return;
      }
      if (!isAbsoluteHttpUrl(incoming.url)) {
        response.writeHead(400);
        response.end();
        return;
      }
      void forwardHttpProxyRequest(incoming, response, route, acquirePreconnectedRoute);
    };
  const server = createServer(createRequestHandler(false));
  const controlServer = options.controlSocketPath
    ? createServer(createRequestHandler(true))
    : undefined;

  const closeStartupResources = async () => {
    stopWatchingRuntime();
    await remoteOperations?.close();
    await crashRecovery?.close();
    await closeServerIfListening(controlServer);
    await closeRuntimeAndState();
  };
  server.on("connect", (incoming, clientSocket, head) => {
    const route = authorizeProxyRequest(
      incoming.headers["proxy-authorization"],
      options.proxyAuthentication,
    );
    if (route === undefined) {
      rejectConnectProxyAuthentication(clientSocket);
      return;
    }
    void forwardConnectRequest(
      incoming,
      clientSocket,
      head,
      route,
      acquirePreconnectedRoute,
      options.preconnectTimeoutMs ?? 10_000,
    );
  });

  try {
    if (controlServer && options.controlSocketPath) {
      await mkdir(dirname(options.controlSocketPath), { mode: 0o700, recursive: true });
      await prepareControlSocketPath(options.controlSocketPath);
      await new Promise<void>((resolve, reject) => {
        controlServer.once("error", reject);
        controlServer.listen(options.controlSocketPath, () => {
          controlServer.off("error", reject);
          resolve();
        });
      });
      await chmod(options.controlSocketPath, 0o600);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await closeStartupResources();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    await closeStartupResources();
    throw new Error("egressd did not bind a TCP address");
  }

  let healthCheckRunning = false;
  let healthCheckRun: Promise<void> | undefined;
  const healthCheckAbort = new AbortController();
  const healthCheckTimer = healthController
    ? setInterval(
        () => {
          if (healthCheckRunning) {
            return;
          }
          healthCheckRunning = true;
          const run = healthController.runDue(Date.now(), healthCheckAbort.signal);
          healthCheckRun = run;
          const finishRun = () => {
            healthCheckRunning = false;
            if (healthCheckRun === run) {
              healthCheckRun = undefined;
            }
          };
          void run.then(finishRun, finishRun);
        },
        Math.min(1_000, options.healthCheckIntervalMs ?? 30_000),
      )
    : undefined;

  let closed = false;
  return {
    address: { host: options.host, port: address.port },
    ...(options.controlSocketPath === undefined
      ? {}
      : { controlSocketPath: options.controlSocketPath }),
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      stopWatchingRuntime();
      const recoveryClosing = crashRecovery?.close();
      if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
      }
      healthCheckAbort.abort();
      if (healthCheckRun) {
        await waitForBoundedCompletion(healthCheckRun, 1_000);
      }
      const operationsClosing = remoteOperations?.close();
      try {
        await Promise.all([closeServer(server), closeServerIfListening(controlServer)]);
        await operationsClosing;
        if (recoveryClosing) {
          await waitForBoundedCompletion(recoveryClosing, 1_000);
        }
        if (retirementOperations.size > 0) {
          await waitForBoundedCompletion(
            Promise.allSettled([...retirementOperations]).then(() => undefined),
            1_000,
          );
        }
        await withControlPlaneLock(() => undefined);
      } finally {
        try {
          await options.mihomoRuntime?.close?.();
        } finally {
          await state?.close();
        }
      }
    },
    healthSnapshot: () => healthController?.snapshot() ?? [],
    importLocalSubscription,
    setNodeEnabled: (id, enabled) => healthController?.setManualEnabled(id, enabled) ?? false,
  };
}

async function applyRuntimeRevision(
  runtime: MihomoRuntime,
  revision: ImportedVlessRevision,
  generations: ReadonlyMap<string, RuntimeGeneration>,
  checkListener: (listener: URL) => Promise<void>,
  applied?: () => void,
): Promise<ReadonlyMap<string, URL>> {
  const listeners = await runtime.apply(revision.mihomoConfig, {
    preserveListeners: [...generations.values()].map(({ listener }) => listener),
  });
  applied?.();
  for (const node of revision.nodes) {
    const listener = listeners.get(node.name);
    if (!listener || !isLoopbackHttpUrl(listener)) {
      throw new Error(`Mihomo runtime did not start a loopback listener for ${node.name}`);
    }
    await checkListener(listener);
  }
  return listeners;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prepareTransientNodeRevision(
  sourceId: string,
  imported: ImportedVlessRevision,
): PreparedNodeRevision {
  return {
    imported,
    nodes: imported.nodes.map((node) => {
      const listener = imported.mihomoConfig.listeners.find(
        (candidate) => candidate.proxy === node.name,
      );
      if (!listener) {
        throw new Error(`revision has no listener for ${node.name}`);
      }
      return {
        generation: nodeGeneration(node),
        listenerPort: listener.port,
        logicalId: `${sourceId}:${node.name}`,
        node,
      };
    }),
  };
}

function preparePersistedNodeRevision(
  imported: ImportedVlessRevision,
  persistedNodes: readonly PersistedNodeGeneration[],
): PreparedNodeRevision {
  const nodes = imported.nodes.map((node) => {
    const persisted = persistedNodes.find((candidate) => candidate.node.name === node.name);
    if (!persisted) {
      throw new Error(`persisted revision has no generation for ${node.name}`);
    }
    return persisted;
  });
  const ports = new Map(nodes.map(({ listenerPort, node }) => [node.name, listenerPort]));
  return {
    imported: {
      mihomoConfig: {
        listeners: imported.mihomoConfig.listeners.map((listener) => ({
          ...listener,
          port: ports.get(listener.proxy) as number,
        })),
        proxies: imported.mihomoConfig.proxies,
      },
      nodes: imported.nodes,
    },
    nodes,
  };
}

function generationKey(id: string, generation: string, listener: URL): string {
  return `${id}\0${generation}\0${listener.href}`;
}

function waitForBoundedCompletion(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    void operation.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      () => {
        clearTimeout(timeout);
        resolve();
      },
    );
  });
}

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("local subscription exceeds 1 MiB"));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    incoming.on("error", reject);
  });
}

function parseRemoteSubscriptionRequest(body: string): string {
  const document = JSON.parse(body) as { url?: unknown };
  if (typeof document.url !== "string") {
    throw new Error("remote subscription URL is required");
  }
  let url: URL;
  try {
    url = new URL(document.url);
  } catch {
    throw new Error("remote subscription URL must be valid");
  }
  if (url.protocol !== "https:") {
    throw new Error("remote subscription URL must use HTTPS");
  }
  return document.url;
}

function parseNodeAliasRequest(body: string): string {
  let document: { alias?: unknown };
  try {
    document = JSON.parse(body) as { alias?: unknown };
  } catch {
    throw new NodeAliasRequestError("node alias request must be valid JSON");
  }
  if (
    typeof document.alias !== "string" ||
    document.alias.length === 0 ||
    document.alias.length > 128 ||
    [...document.alias].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new NodeAliasRequestError("node alias must be between 1 and 128 printable characters");
  }
  return document.alias;
}

class NodeAliasRequestError extends Error {}

function decodeNodeLogicalId(encoded: string): string {
  try {
    const logicalNodeId = decodeURIComponent(encoded);
    if (!logicalNodeId) {
      throw new Error("empty node ID");
    }
    return logicalNodeId;
  } catch {
    throw new NodeAliasRequestError("node ID must be valid percent-encoded text");
  }
}

function createAsyncLock(): <Result>(operation: () => Promise<Result> | Result) => Promise<Result> {
  let tail = Promise.resolve();
  return async <Result>(operation: () => Promise<Result> | Result): Promise<Result> => {
    const previous = tail;
    let release: () => void = () => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function isAuthorizedAdmin(incoming: IncomingMessage, adminToken: string | undefined): boolean {
  return Boolean(adminToken && incoming.headers.authorization === `Bearer ${adminToken}`);
}

function rejectAdminAuthentication(response: import("node:http").ServerResponse): void {
  response.writeHead(401, { "www-authenticate": "Bearer" });
  response.end();
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function checkListenerReady(listener: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(listener.port || 80), listener.hostname);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Mihomo listener readiness timed out"));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

type PreconnectedRoute = { latencyMs: number; lease: SchedulerLease; socket: Socket };
type PreconnectedRouteAcquirer = (
  route: ProxyRoute,
  signal: AbortSignal,
  confirmConnection?: (socket: Socket) => Promise<void>,
) => Promise<PreconnectedRoute | "not-implemented" | undefined>;

async function forwardHttpProxyRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  route: ProxyRoute,
  acquirePreconnectedRoute: PreconnectedRouteAcquirer,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ClientCancelledError());
  incoming.once("aborted", cancel);
  response.once("close", cancel);
  let connected: PreconnectedRoute | "not-implemented" | undefined;
  try {
    connected = await acquirePreconnectedRoute(route, controller.signal);
  } catch (error) {
    incoming.off("aborted", cancel);
    response.off("close", cancel);
    if (error instanceof ClientCancelledError) {
      return;
    }
    response.writeHead(error instanceof SessionCapacityError ? 429 : 503);
    response.end();
    return;
  }
  incoming.off("aborted", cancel);
  response.off("close", cancel);
  if (connected === "not-implemented") {
    response.writeHead(501);
    response.end();
    return;
  }
  if (!connected) {
    response.writeHead(502);
    response.end();
    return;
  }

  const { latencyMs, lease, socket } = connected;
  let clientCancelled = false;
  const markClientCancelled = () => {
    clientCancelled = true;
  };
  incoming.once("aborted", markClientCancelled);
  response.once("close", markClientCancelled);
  const { "proxy-authorization": _proxyAuthorization, ...forwardedHeaders } = incoming.headers;
  const upstream = request(
    {
      agent: false,
      createConnection: () => socket,
      headers: {
        ...forwardedHeaders,
        via: appendVia(incoming.headers.via, "1.1 egresskit"),
      },
      host: lease.candidate.listener.hostname,
      method: incoming.method,
      path: incoming.url,
      port: Number(lease.candidate.listener.port || 80),
    },
    (upstreamResponse) => {
      lease.reportConnectionSuccess(latencyMs);
      upstreamResponse.once("close", lease.release);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!clientCancelled) {
      lease.reportConnectionFailure();
    }
    lease.release();
    if (!response.headersSent) {
      response.writeHead(502);
    }
    response.end();
  });
  response.once("close", lease.release);
  incoming.pipe(upstream);
}

async function forwardConnectRequest(
  incoming: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  route: ProxyRoute,
  acquirePreconnectedRoute: PreconnectedRouteAcquirer,
  preconnectTimeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new ClientCancelledError());
  clientSocket.once("close", cancel);
  clientSocket.once("end", cancel);
  clientSocket.once("error", cancel);
  const stopWatchingForCancellation = () => {
    clientSocket.off("close", cancel);
    clientSocket.off("end", cancel);
    clientSocket.off("error", cancel);
  };
  let connected: PreconnectedRoute | "not-implemented" | undefined;
  let handshake: ConnectHandshake | undefined;
  try {
    connected = await acquirePreconnectedRoute(route, controller.signal, async (socket) => {
      handshake = await performConnectHandshake(
        socket,
        incoming.url ?? "",
        preconnectTimeoutMs,
        controller.signal,
      );
    });
  } catch (error) {
    stopWatchingForCancellation();
    if (error instanceof ClientCancelledError) {
      clientSocket.destroy();
      return;
    }
    clientSocket.end(
      error instanceof SessionCapacityError
        ? "HTTP/1.1 429 Too Many Requests\r\n\r\n"
        : "HTTP/1.1 503 Service Unavailable\r\n\r\n",
    );
    return;
  }
  stopWatchingForCancellation();
  if (connected === "not-implemented") {
    clientSocket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
    return;
  }
  if (!connected) {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  if (!handshake) {
    connected.socket.destroy();
    connected.lease.release();
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  connected.lease.reportConnectionSuccess(connected.latencyMs);
  clientSocket.once("close", connected.lease.release);
  clientSocket.write(handshake.header);
  if (head.length > 0) {
    connected.socket.write(head);
  }
  if (handshake.remaining.length > 0) {
    clientSocket.write(handshake.remaining);
  }
  clientSocket.pipe(connected.socket);
  connected.socket.pipe(clientSocket);
  clientSocket.on("error", () => connected.socket.destroy());
  connected.socket.on("error", () => clientSocket.destroy());
  clientSocket.once("close", () => connected.socket.destroy());
  connected.socket.once("close", () => clientSocket.destroy());
}

class ClientCancelledError extends Error {}

function observeConnectionOutcome(
  lease: SchedulerLease,
  observer: EgressdOptions["onConnectionOutcome"],
): SchedulerLease {
  let reported = false;
  const notify = (outcome: ConnectionOutcome) => {
    try {
      observer?.(outcome);
    } catch {
      // Observability hooks must not affect proxy traffic.
    }
  };
  return {
    candidate: lease.candidate,
    release: lease.release,
    reportConnectionFailure: () => {
      if (reported) {
        return;
      }
      reported = true;
      lease.reportConnectionFailure();
      notify({ nodeId: lease.candidate.id, result: "failure" });
    },
    reportConnectionSuccess: (latencyMs) => {
      if (reported) {
        return;
      }
      reported = true;
      lease.reportConnectionSuccess(latencyMs);
      notify({ latencyMs, nodeId: lease.candidate.id, result: "success" });
    },
  };
}

function connectMihomoListener(
  listener: URL,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(listener.port || 80), listener.hostname);
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("Mihomo listener connection timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onAbort = () => {
      socket.destroy();
      finish(new ClientCancelledError());
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", onConnect);
    socket.once("error", onError);
    if (signal.aborted) {
      onAbort();
    }
  });
}

interface ConnectHandshake {
  header: Buffer;
  remaining: Buffer;
}

function performConnectHandshake(
  listenerSocket: Socket,
  authority: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ConnectHandshake> {
  return new Promise((resolve, reject) => {
    let responseHead = Buffer.alloc(0);
    const timeout = setTimeout(
      () => finish(new Error("Mihomo CONNECT response timed out")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      listenerSocket.off("data", onData);
      listenerSocket.off("error", onError);
      listenerSocket.off("close", onClose);
    };
    const finish = (error: Error | undefined, result?: ConnectHandshake) => {
      cleanup();
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };
    const onAbort = () => finish(new ClientCancelledError());
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Mihomo closed before CONNECT was established"));
    const onData = (chunk: Buffer) => {
      responseHead = Buffer.concat([responseHead, chunk]);
      const end = responseHead.indexOf("\r\n\r\n");
      if (end === -1) {
        if (responseHead.length > 64 * 1024) {
          finish(new Error("Mihomo CONNECT response headers are too large"));
        }
        return;
      }
      const header = responseHead.subarray(0, end + 4);
      if (!header.toString("latin1").startsWith("HTTP/1.1 200")) {
        finish(new Error("Mihomo rejected CONNECT before tunnel establishment"));
        return;
      }
      finish(undefined, { header, remaining: responseHead.subarray(end + 4) });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    listenerSocket.on("data", onData);
    listenerSocket.once("error", onError);
    listenerSocket.once("close", onClose);
    listenerSocket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nVia: 1.1 egresskit\r\n\r\n`,
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function isFallbackRoute(route: ProxyRoute): boolean {
  return route.mode === "rotate" || route.mode === "sticky";
}

function validatePreconnectAttempts(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 10)) {
    throw new Error("pre-connect attempts must be an integer between 1 and 10");
  }
}

function validatePreconnectTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 60_000)) {
    throw new Error("pre-connect timeout must be an integer between 1 and 60000 milliseconds");
  }
}

function isAbsoluteHttpUrl(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function appendVia(current: IncomingHttpHeaders["via"], value: string): string {
  if (current === undefined) {
    return value;
  }
  return `${Array.isArray(current) ? current.join(", ") : current}, ${value}`;
}
