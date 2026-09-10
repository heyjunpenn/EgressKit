import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { redactSubscriptionUrl } from "./control-cli.js";
import {
  type ExitIpIdentity,
  type ExitIpProbe,
  type HealthProbe,
  NodeHealthController,
  type NodeHealthSnapshot,
} from "./health.js";
import { MihomoCrashRecovery, type MihomoRecoveryClock } from "./mihomo-recovery.js";
import { isLoopbackHost, isLoopbackHttpUrl } from "./network.js";
import { EgressdMetrics, subscriptionLogOrigin } from "./observability.js";
import {
  authorizeProxyRequest,
  type ProxyAuthentication,
  type ProxyRoute,
  ProxyTokenRegistry,
  rejectConnectProxyAuthentication,
  rejectHttpProxyAuthentication,
} from "./proxy-auth.js";
import {
  type RemoteOperationClock,
  RemoteOperationRunner,
  validateMinimumSubscriptionNodes,
  validateRemoteSubscriptionTimeout,
} from "./remote-operation.js";
import { parseRuntimeSettings, restartRequiredSettingFields } from "./runtime-settings.js";
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
  type ControlState,
  NodeAliasConflictError,
  NodeAliasTargetNotFoundError,
  nodeGeneration,
  openControlState,
  type PersistedNodeGeneration,
  type PreparedNodeRevision,
  RevisionForceConflictError,
} from "./state.js";
import { serveStaticWeb } from "./static-web.js";
import { type ImportedVlessRevision, importLocalVlessYaml } from "./subscription.js";
import {
  TargetFeedbackError,
  type TargetFeedbackOutcome,
  TargetReputation,
} from "./target-reputation.js";

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
  exitIpCheckBatchSize?: number;
  adminToken?: string;
  allowUnsafeUnauthenticatedProxy?: boolean;
  controlSocketPath?: string;
  checkMihomoListener?: (listener: URL) => Promise<void>;
  fetchSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  healthCheckConcurrency?: number;
  exitIpProbe?: ExitIpProbe;
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
  remoteSubscriptionRefreshIntervalMs?: number;
  schedulerSignals?: ReadonlyMap<string, SchedulerSignals>;
  sessionAbsoluteTtlMs?: number;
  sessionBindingStore?: SessionBindingStore;
  sessionClock?: SessionClock;
  sessionIdleTimeoutMs?: number;
  sessionMaximumActiveSessions?: number;
  sessionMaximumConcurrentConnections?: number;
  stateDirectory?: string;
  targetReputationClock?: () => number;
  targetReputationEnabled?: boolean;
  webDirectory?: string;
  wgetSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<string>;
}

export interface ConnectionOutcome {
  latencyMs?: number;
  nodeId: string;
  result: "failure" | "success";
}

export type EgressdLogEvent =
  | {
      event: "egressd.proxy_auth.disabled";
      exposure: "non-loopback";
      host: string;
      level: "warn";
    }
  | {
      event: "egressd.connection";
      latencyMs?: number;
      level: "info" | "warn";
      result: "failure" | "success";
    }
  | { attempt: number; event: "egressd.fallback"; level: "info" }
  | {
      event: "egressd.subscription.remote.created";
      level: "info";
      subscriptionOrigin: string;
    }
  | {
      event: "egressd.node.lifecycle";
      level: "info";
      nodeId: string;
      status: string;
    }
  | {
      event: "egressd.node.exit_verification";
      failed: number;
      level: "info";
      reason: "manual" | "subscription-activated";
      succeeded: number;
      total: number;
    }
  | {
      event: "egressd.node.exit_verified";
      level: "info";
      nodeId: string;
      provider: string;
    }
  | {
      event: "egressd.runtime.revision";
      level: "info";
      nodeCount: number;
      status: "ready";
    }
  | {
      event: "egressd.subscription.lifecycle";
      level: "info" | "warn";
      operationId: string;
      stage: string;
      status: "failed" | "running" | "succeeded";
    };

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

function trackServerSockets(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    const forceCloseTimer = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections();
    }, 1_000);
    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });
}

function closeServerIfListening(
  server: Server | undefined,
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  return server?.listening ? closeServer(server, sockets) : Promise.resolve();
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
  const metrics = new EgressdMetrics();
  const emitLog = (event: EgressdLogEvent) => {
    try {
      (options.log ?? ((entry) => process.stderr.write(`${JSON.stringify(entry)}\n`)))(event);
    } catch {
      // Observability hooks must not affect daemon behavior.
    }
  };
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
    emitLog(event);
  }
  const proxyTokenRegistry =
    options.proxyAuthentication === false
      ? undefined
      : new ProxyTokenRegistry({
          initialTokens:
            options.proxyAuthentication && "tokens" in options.proxyAuthentication
              ? options.proxyAuthentication.tokens
              : [],
        });
  let configuredProxyToken =
    options.proxyAuthentication && "tokens" in options.proxyAuthentication
      ? options.proxyAuthentication.tokens[0]
      : undefined;
  const activeProxyAuthentication: ProxyAuthentication =
    options.proxyAuthentication === false ? false : (proxyTokenRegistry as ProxyTokenRegistry);
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
    { requireExitIdentity: options.exitIpProbe !== undefined },
  );
  const targetReputation = options.targetReputationEnabled
    ? new TargetReputation({
        ...(options.targetReputationClock === undefined
          ? {}
          : { now: options.targetReputationClock }),
      })
    : undefined;
  const state = options.stateDirectory ? await openControlState(options.stateDirectory) : undefined;
  const exitIdentitiesByNode = new Map<string, ExitIpIdentity>();
  const healthController = options.healthCheckUrls
    ? new NodeHealthController({
        ...(options.healthCheckConcurrency === undefined
          ? {}
          : { concurrency: options.healthCheckConcurrency }),
        healthUrls: options.healthCheckUrls,
        ...(options.exitIpProbe === undefined ? {} : { exitIpProbe: options.exitIpProbe }),
        ...(options.healthCheckIntervalMs === undefined
          ? {}
          : { intervalMs: options.healthCheckIntervalMs }),
        ...(options.healthCheckJitterMs === undefined
          ? {}
          : { jitterMs: options.healthCheckJitterMs }),
        onExitIdentity: (id, identity) => {
          const candidate = scheduler.snapshot().find(({ id: candidateId }) => candidateId === id);
          if (!candidate) return;
          state?.saveExitIdentity({
            ...identity,
            generation: candidate.generation,
            logicalId: id,
          });
          exitIdentitiesByNode.set(id, identity);
          scheduler.setExitIp(id, identity.ip);
          emitLog({
            event: "egressd.node.exit_verified",
            level: "info",
            nodeId: id,
            provider: identity.provider,
          });
        },
        onExitIdentityCleared: (id) => {
          const candidate = scheduler.snapshot().find(({ id: candidateId }) => candidateId === id);
          if (!candidate) return;
          state?.deleteExitIdentity(id, candidate.generation);
          exitIdentitiesByNode.delete(id);
          scheduler.clearExitIp(id);
          emitLog({
            event: "egressd.node.lifecycle",
            level: "info",
            nodeId: id,
            status: "unavailable",
          });
        },
        onProbeResult: (id, succeeded) => scheduler.reportHealthCheck(id, succeeded),
        onStatusChange: (id, status) => {
          scheduler.setHealthStatus(id, status);
          emitLog({ event: "egressd.node.lifecycle", level: "info", nodeId: id, status });
        },
        ...(options.healthCheckProbe === undefined ? {} : { probe: options.healthCheckProbe }),
        ...(options.healthCheckSuccessThreshold === undefined
          ? {}
          : { successThreshold: options.healthCheckSuccessThreshold }),
        ...(options.exitIpCheckBatchSize === undefined
          ? {}
          : { scheduledBatchSize: options.exitIpCheckBatchSize }),
      })
    : undefined;
  if (healthController) {
    healthController.replaceNodes(
      scheduler.snapshot().map(({ generation, id, listener }) => ({ generation, id, listener })),
    );
  }
  const applyPersistedExitIdentities = () => {
    for (const candidate of scheduler.snapshot()) {
      const persisted = state?.getExitIdentity(candidate.id, candidate.generation);
      if (!persisted) continue;
      const identity: ExitIpIdentity = {
        ...(persisted.city === undefined ? {} : { city: persisted.city }),
        ...(persisted.country === undefined ? {} : { country: persisted.country }),
        ip: persisted.ip,
        provider: persisted.provider,
        verifiedAt: persisted.verifiedAt,
      };
      exitIdentitiesByNode.set(candidate.id, identity);
      scheduler.setExitIp(candidate.id, identity.ip);
      healthController?.restoreExitIdentity(candidate.id, identity);
    }
  };
  const applyNodeEnabledOverrides = () => {
    for (const [id, enabled] of state?.getNodeEnabledOverrides() ?? []) {
      scheduler.setManualEnabled(id, enabled);
      healthController?.setManualEnabled(id, enabled);
    }
  };
  const verifyAllExits = async (reason: "manual" | "subscription-activated") => {
    if (!healthController) return { failed: 0, succeeded: 0, total: 0 };
    const results = await healthController.verifyAllExits();
    const succeeded = results.filter(({ identity }) => identity !== undefined).length;
    const summary = { failed: results.length - succeeded, succeeded, total: results.length };
    emitLog({ event: "egressd.node.exit_verification", level: "info", reason, ...summary });
    return summary;
  };
  const setNodeEnabled = (id: string, enabled: boolean): boolean => {
    if (!scheduler.hasCandidate(id)) {
      return false;
    }
    state?.saveNodeEnabledOverride(id, enabled);
    scheduler.setManualEnabled(id, enabled);
    healthController?.setManualEnabled(id, enabled);
    return true;
  };
  try {
    const persistedProxyTokens = state?.loadProxyTokens();
    if (proxyTokenRegistry && persistedProxyTokens && persistedProxyTokens.length > 0) {
      proxyTokenRegistry.restore(persistedProxyTokens);
    } else if (state && proxyTokenRegistry) {
      state.saveProxyTokens(proxyTokenRegistry.persistedSnapshot());
    }
    applyNodeEnabledOverrides();
    applyPersistedExitIdentities();
  } catch (error) {
    await state?.close();
    throw error;
  }
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
      return softStickySessions.acquireStrict(route.sessionKey, excludedIds);
    }
    if (route.mode === "node") {
      return scheduler.acquireBySelector(route.selector, excludedIds);
    }
    return "not-implemented" as const;
  };

  const acquirePreconnectedRoute = async (
    route: ProxyRoute,
    target: string,
    signal: AbortSignal,
    confirmConnection?: (socket: Socket) => Promise<void>,
  ): Promise<
    { latencyMs: number; lease: SchedulerLease; socket: Socket } | "not-implemented" | undefined
  > => {
    const attemptedIds = new Set<string>(targetReputation?.excludedNodeIds(target) ?? []);
    const maximumAttempts = isFallbackRoute(route) ? (options.preconnectAttempts ?? 3) : 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (attempt > 0) {
        metrics.recordFallback();
        emitLog({ attempt: attempt + 1, event: "egressd.fallback", level: "info" });
      }
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
        metrics.recordConnection(outcome);
        emitLog({
          event: "egressd.connection",
          ...(outcome.latencyMs === undefined ? {} : { latencyMs: outcome.latencyMs }),
          level: outcome.result === "success" ? "info" : "warn",
          result: outcome.result,
        });
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
    applyPersistedExitIdentities();
    applyNodeEnabledOverrides();
    runtimeConfiguration.active = prepared.imported;
    runtimeConfiguration.candidate = undefined;
    runtimeConfiguration.status = "ready";
    emitLog({
      event: "egressd.runtime.revision",
      level: "info",
      nodeCount: prepared.imported.nodes.length,
      status: "ready",
    });
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
        source: { id: "local", kind: "local", locator: "inline", name: "本地配置" },
      });
      void verifyAllExits("subscription-activated");
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
        ...(options.wgetSubscription === undefined
          ? {}
          : { wgetSubscription: options.wgetSubscription }),
        runControlPlaneOperation: withControlPlaneLock,
        onSubscriptionActivated: () => void verifyAllExits("subscription-activated"),
        onLifecycle: ({ operationId, stage, status }) =>
          emitLog({
            event: "egressd.subscription.lifecycle",
            level: status === "failed" ? "warn" : "info",
            operationId,
            stage,
            status,
          }),
        state,
      })
    : undefined;

  let publicPort = options.port;
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
          scheduler.hasSchedulableCandidate();
        writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" });
        return;
      }

      const verifyExitMatch = incoming.url?.match(/^\/nodes\/([^/]+)\/verify-exit$/);
      if (incoming.method === "POST" && incoming.url === "/nodes/verify-exits") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!healthController) {
          writeJson(response, 503, { error: "exit verification unavailable" });
          return;
        }
        void verifyAllExits("manual")
          .then((summary) => writeJson(response, 200, summary))
          .catch((error) =>
            writeJson(response, 503, {
              error: error instanceof Error ? error.message : "exit verification unavailable",
            }),
          );
        return;
      }
      if (incoming.method === "POST" && verifyExitMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        const nodeId = decodeURIComponent(verifyExitMatch[1] as string);
        if (!scheduler.hasCandidate(nodeId)) {
          writeJson(response, 404, { error: "node not found" });
          return;
        }
        if (!healthController) {
          writeJson(response, 503, { error: "exit verification unavailable" });
          return;
        }
        void healthController
          .verifyExit(nodeId)
          .then((identity) =>
            identity
              ? writeJson(response, 200, { ...identity })
              : writeJson(response, 502, { error: "exit verification failed" }),
          )
          .catch(() => writeJson(response, 502, { error: "exit verification failed" }));
        return;
      }

      if (incoming.method === "GET" && incoming.url === "/console/snapshot") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        const candidates = scheduler.snapshot();
        const healthById = new Map(
          (healthController?.snapshot() ?? []).map((snapshot) => [snapshot.id, snapshot]),
        );
        const nodeStatuses: Record<string, number> = {};
        const nodes = candidates.map((candidate) => {
          const health = healthById.get(candidate.id);
          const exitIdentity = exitIdentitiesByNode.get(candidate.id);
          const enabled = candidate.manualWeight > 0 && health?.manuallyEnabled !== false;
          const status = exitIdentity ? "available" : "unavailable";
          nodeStatuses[status] = (nodeStatuses[status] ?? 0) + 1;
          return {
            activeConnections: candidate.activeConnections,
            ...(candidate.selectors?.[0] === undefined ? {} : { alias: candidate.selectors[0] }),
            enabled,
            ...(exitIdentity
              ? {
                  exitIp: exitIdentity.ip,
                  exitLocation: [exitIdentity.country, exitIdentity.city].filter(Boolean).join("-"),
                  exitProvider: exitIdentity.provider,
                  exitVerifiedAt: exitIdentity.verifiedAt,
                }
              : {}),
            id: candidate.id,
            latencyMs: Math.round(candidate.ewmaLatencyMs),
            status,
            successRate: candidate.successRate,
          };
        });
        const drainingNodes = scheduler.drainingCount();
        if (drainingNodes > 0) {
          nodeStatuses.draining = drainingNodes;
        }
        const connectionCounts = metrics.connectionSnapshot();
        const activeConnectionCounts = softStickySessions.redactedActiveConnectionCounts();
        const exitIpStats = new Map<string, { location?: string; nodeCount: number }>();
        for (const node of nodes) {
          if (!("exitIp" in node) || typeof node.exitIp !== "string") continue;
          const existing = exitIpStats.get(node.exitIp);
          exitIpStats.set(node.exitIp, {
            ...(existing?.location
              ? { location: existing.location }
              : "exitLocation" in node && typeof node.exitLocation === "string"
                ? { location: node.exitLocation }
                : {}),
            nodeCount: (existing?.nodeCount ?? 0) + 1,
          });
        }
        const exitIps = Array.from(exitIpStats, ([ip, statistic]) => ({ ip, ...statistic })).sort(
          (left, right) => left.ip.localeCompare(right.ip),
        );
        writeJson(response, 200, {
          exitIps,
          gateway: {
            host: options.host,
            port: publicPort,
            ready:
              runtimeAvailable &&
              runtimeConfiguration.status === "ready" &&
              scheduler.hasSchedulableCandidate(),
          },
          generatedAt: new Date().toISOString(),
          metrics: {
            activeSessions: softStickySessions.countActiveSessions(),
            failedConnections: connectionCounts.failed,
            healthyNodes: nodeStatuses.healthy ?? 0,
            successConnections: connectionCounts.succeeded,
            totalNodes: nodes.length,
          },
          nodes,
          nodeStatusCounts: nodeStatuses,
          operationCounts: state?.operationStatusCounts() ?? {},
          operations: state?.listConsoleOperations() ?? [],
          sessions: (state?.listConsoleSessions() ?? []).map((session) => ({
            ...session,
            activeConnections: activeConnectionCounts.get(session.id) ?? 0,
          })),
          subscriptions: (state?.listConsoleSubscriptions() ?? []).map((subscription) => ({
            ...subscription,
            locator:
              subscription.kind === "remote"
                ? redactSubscriptionUrl(subscription.locator)
                : "local source",
          })),
        });
        return;
      }

      if (incoming.method === "GET" && incoming.url === "/metrics") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        try {
          const nodeStatuses: Record<string, number> = {};
          for (const candidate of scheduler.snapshot()) {
            const status = scheduler.healthStatus(candidate.id) ?? "healthy";
            nodeStatuses[status] = (nodeStatuses[status] ?? 0) + 1;
          }
          const draining = scheduler.drainingCount();
          if (draining > 0) {
            nodeStatuses.draining = draining;
          }
          const body = metrics.render({
            activeSessions: softStickySessions.countActiveSessions(),
            nodeStatuses,
            operationStatuses: state?.operationStatusCounts() ?? {},
          });
          response.writeHead(200, {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
          });
          response.end(body);
        } catch {
          writeJson(response, 503, { error: "metrics unavailable" });
        }
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
            const runtimeUnavailable = message.includes("runtime") || message.includes("listener");
            writeJson(response, runtimeUnavailable ? 503 : 422, {
              error: runtimeUnavailable
                ? "local subscription runtime unavailable"
                : "local subscription is invalid",
            });
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
          .then(({ name, url }) => ({
            created: state.createRemoteSubscription(url, name),
            subscriptionOrigin: subscriptionLogOrigin(url),
          }))
          .then(({ created, subscriptionOrigin }) => {
            emitLog({
              event: "egressd.subscription.remote.created",
              level: "info",
              subscriptionOrigin,
            });
            return created;
          })
          .then((created) => {
            writeJson(response, 202, {
              operationId: created.operationId,
              revisionId: created.subscriptionRevisionId,
              status: "queued",
              subscriptionId: created.subscriptionId,
            });
            remoteOperations?.enqueue(created.operationId, created.subscriptionId);
          })
          .catch(() =>
            writeJson(response, 422, { error: "remote subscription request is invalid" }),
          );
        return;
      }

      if (incoming.method === "GET" && incoming.url === "/proxy-tokens") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        writeJson(response, 200, { tokens: proxyTokenRegistry?.snapshot() ?? [] });
        return;
      }

      if (incoming.method === "GET" && incoming.url === "/settings") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state || !options.adminToken) {
          writeJson(response, 503, { error: "durable settings are not configured" });
          return;
        }
        writeJson(response, 200, {
          restartRequiredFields: restartRequiredSettingFields,
          settings: state.loadRuntimeSettings(options.adminToken),
        });
        return;
      }

      if (incoming.method === "PUT" && incoming.url === "/settings") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state || !options.adminToken) {
          writeJson(response, 503, { error: "durable settings are not configured" });
          return;
        }
        readBody(incoming)
          .then((body) => parseRuntimeSettings(JSON.parse(body)))
          .then((settings) => {
            const previous = state.loadRuntimeSettings(options.adminToken as string);
            state.updateRuntimeSettings(settings);
            if (
              proxyTokenRegistry &&
              settings.proxyAuthEnabled &&
              settings.proxyToken !== previous.proxyToken
            ) {
              proxyTokenRegistry.replaceAll([settings.proxyToken]);
              state.saveProxyTokens(proxyTokenRegistry.persistedSnapshot());
              configuredProxyToken = settings.proxyToken;
            }
            const changedRestartFields = restartRequiredSettingFields.filter(
              (key) => JSON.stringify(previous[key]) !== JSON.stringify(settings[key]),
            );
            writeJson(response, 200, {
              restartRequired: changedRestartFields.length > 0,
              restartRequiredFields: changedRestartFields,
              settings,
            });
          })
          .catch((error: unknown) =>
            writeJson(response, 422, {
              error: error instanceof Error ? error.message : "settings request is invalid",
            }),
          );
        return;
      }

      if (incoming.method === "GET" && incoming.url === "/playground/config") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        writeJson(response, 200, {
          proxyToken: configuredProxyToken ?? "",
          proxyTokenAvailable:
            options.proxyAuthentication === false || configuredProxyToken !== undefined,
        });
        return;
      }

      if (incoming.method === "POST" && incoming.url === "/playground/execute") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        readBody(incoming)
          .then(parsePlaygroundRequest)
          .then((playground) =>
            executePlaygroundRequest({
              host: options.host,
              port: publicPort,
              proxyAuthenticationDisabled: options.proxyAuthentication === false,
              ...(configuredProxyToken === undefined ? {} : { proxyToken: configuredProxyToken }),
              ...playground,
            }),
          )
          .then((result) => writeJson(response, 200, result))
          .catch((error: unknown) =>
            writeJson(response, 422, {
              error: error instanceof Error ? error.message : "playground request failed",
            }),
          );
        return;
      }

      if (incoming.method === "POST" && incoming.url === "/proxy-tokens") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!proxyTokenRegistry) {
          writeJson(response, 409, { error: "proxy authentication is disabled" });
          return;
        }
        readBody(incoming)
          .then(parseProxyTokenRequest)
          .then((token) => {
            const added = commitProxyTokenMutation(proxyTokenRegistry, state, () =>
              proxyTokenRegistry.add(token),
            );
            writeJson(response, 201, added);
          })
          .catch(() => writeJson(response, 422, { error: "proxy token request is invalid" }));
        return;
      }

      if (incoming.method === "POST" && incoming.url === "/reputation/feedback") {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!targetReputation) {
          writeJson(response, 409, { error: "target reputation is disabled" });
          return;
        }
        readBody(incoming)
          .then(parseTargetFeedbackRequest)
          .then((feedback) => {
            if (!scheduler.hasCandidate(feedback.nodeId)) {
              writeJson(response, 404, { error: "active node not found" });
              return;
            }
            writeJson(response, 202, { ...targetReputation.record(feedback) });
          })
          .catch((error: unknown) =>
            writeJson(response, 422, {
              error:
                error instanceof TargetFeedbackError
                  ? error.message
                  : "target feedback request is invalid",
            }),
          );
        return;
      }

      const proxyTokenMatch = incoming.url?.match(/^\/proxy-tokens\/([^/]+)$/);
      if (incoming.method === "DELETE" && proxyTokenMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!proxyTokenRegistry) {
          writeJson(response, 409, { error: "proxy authentication is disabled" });
          return;
        }
        readBody(incoming)
          .then(parseProxyTokenRevocationRequest)
          .then((graceMs) => {
            const id = proxyTokenMatch[1] as string;
            const revoked = commitProxyTokenMutation(proxyTokenRegistry, state, () =>
              proxyTokenRegistry.revoke(id, graceMs),
            );
            if (!revoked) {
              writeJson(response, 404, { error: "proxy token not found" });
              return;
            }
            writeJson(response, 202, { ...revoked, tokenId: id });
          })
          .catch(() =>
            writeJson(response, 422, { error: "proxy token revocation request is invalid" }),
          );
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
          name: subscription.name,
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

      if (incoming.method === "PUT" && subscriptionMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state || !remoteOperations) {
          writeJson(response, 503, { error: "durable control state is not configured" });
          return;
        }
        readBody(incoming)
          .then(parseRemoteSubscriptionRequest)
          .then(({ name, url }) =>
            state.updateRemoteSubscription(subscriptionMatch[1] as string, url, name),
          )
          .then((operation) => {
            writeJson(response, 202, {
              operationId: operation.id,
              revisionId: operation.subscriptionRevisionId,
              status: operation.status,
              subscriptionId: operation.subscriptionId,
            });
            remoteOperations.enqueue(operation.id, operation.subscriptionId);
          })
          .catch(() => writeJson(response, 422, { error: "subscription update is invalid" }));
        return;
      }

      if (incoming.method === "DELETE" && subscriptionMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        if (!state) {
          writeJson(response, 503, { error: "durable control state is not configured" });
          return;
        }
        const subscriptionId = subscriptionMatch[1] as string;
        if (state.hasActiveSubscriptionOperation(subscriptionId)) {
          writeJson(response, 409, { error: "subscription operation is still running" });
          return;
        }
        void withControlPlaneLock(() => {
          if (!state.deleteSubscription(subscriptionId)) {
            writeJson(response, 404, { error: "subscription not found" });
            return;
          }
          const remaining = scheduler
            .snapshot()
            .filter(({ id }) => !id.startsWith(`${subscriptionId}:`));
          scheduler.replaceCandidates(remaining, (drained) => {
            const key = generationKey(drained.id, drained.generation, drained.listener);
            const retired = runtimeGenerations.get(key);
            const runtime = options.mihomoRuntime;
            if (!retired || !runtime) return;
            let removal: Promise<void>;
            removal = runtime
              .removeListener(retired.listener)
              .then(() => {
                state.releaseNodeGeneration(
                  retired.id,
                  retired.generation,
                  retired.listenerPort,
                  Date.now() + (options.portQuarantineMs ?? 60_000),
                );
              })
              .catch(() => undefined)
              .finally(() => {
                if (runtimeGenerations.get(key) === retired) {
                  runtimeGenerations.delete(key);
                }
                retirementOperations.delete(removal);
              });
            retirementOperations.add(removal);
          });
          healthController?.replaceNodes(
            remaining.map(({ generation, id, listener }) => ({ generation, id, listener })),
          );
          runtimeConfiguration.status = remaining.length === 0 ? "not-ready" : "ready";
          response.writeHead(204);
          response.end();
        }).catch(() => writeJson(response, 500, { error: "subscription could not be deleted" }));
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

      const nodeEnabledMatch = incoming.url?.match(/^\/nodes\/([^/]+)\/enabled$/);
      if (incoming.method === "PUT" && nodeEnabledMatch) {
        if (!isAuthorizedAdmin(incoming, options.adminToken)) {
          rejectAdminAuthentication(response);
          return;
        }
        readBody(incoming)
          .then(parseNodeEnabledRequest)
          .then((enabled) => {
            const nodeId = decodeNodeLogicalId(nodeEnabledMatch[1] as string);
            if (!setNodeEnabled(nodeId, enabled)) {
              writeJson(response, 404, { error: "active node not found" });
              return;
            }
            writeJson(response, 200, { enabled, nodeId });
          })
          .catch((error: unknown) => {
            const invalidRequest =
              error instanceof NodeEnabledRequestError || error instanceof NodeAliasRequestError;
            writeJson(response, invalidRequest ? 422 : 500, {
              error: invalidRequest
                ? "node enabled request is invalid"
                : "node enabled state could not be saved",
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

      if (options.webDirectory && incoming.url?.startsWith("/")) {
        void serveStaticWeb(incoming, response, options.webDirectory).then((served) => {
          if (!served) writeJson(response, 404, { error: "management route not found" });
        });
        return;
      }

      const route = authorizeProxyRequest(
        incoming.headers["proxy-authorization"],
        activeProxyAuthentication,
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
  const serverSockets = trackServerSockets(server);
  const controlServerSockets = controlServer
    ? trackServerSockets(controlServer)
    : new Set<Socket>();

  const closeStartupResources = async () => {
    stopWatchingRuntime();
    await remoteOperations?.close();
    await crashRecovery?.close();
    await closeServerIfListening(controlServer, controlServerSockets);
    await closeRuntimeAndState();
  };
  server.on("connect", (incoming, clientSocket, head) => {
    const route = authorizeProxyRequest(
      incoming.headers["proxy-authorization"],
      activeProxyAuthentication,
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
    await closeServer(server, serverSockets);
    await closeStartupResources();
    throw new Error("egressd did not bind a TCP address");
  }
  publicPort = address.port;

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
  const subscriptionRefreshTimer =
    state && remoteOperations
      ? setInterval(
          () => {
            for (const subscriptionId of state.listRemoteSubscriptionIds()) {
              if (state.hasActiveSubscriptionOperation(subscriptionId)) continue;
              const operation = state.createRefreshOperation(subscriptionId);
              remoteOperations.enqueue(operation.id, subscriptionId);
            }
          },
          options.remoteSubscriptionRefreshIntervalMs ?? 10 * 60_000,
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
      if (subscriptionRefreshTimer) clearInterval(subscriptionRefreshTimer);
      healthCheckAbort.abort();
      if (healthCheckRun) {
        await waitForBoundedCompletion(healthCheckRun, 1_000);
      }
      const operationsClosing = remoteOperations?.close();
      try {
        await Promise.all([
          closeServer(server, serverSockets),
          closeServerIfListening(controlServer, controlServerSockets),
        ]);
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
    setNodeEnabled,
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

function parseRemoteSubscriptionRequest(body: string): { name: string; url: string } {
  const document = JSON.parse(body) as { name?: unknown; url?: unknown };
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
  const requestedName = typeof document.name === "string" ? document.name.trim() : "";
  return { name: requestedName || url.hostname, url: document.url };
}

interface PlaygroundRequest {
  mode: "node" | "rotate" | "sticky" | "strict";
  node?: string;
  target: string;
}

function parsePlaygroundRequest(body: string): PlaygroundRequest {
  const document = JSON.parse(body) as { mode?: unknown; node?: unknown; target?: unknown };
  if (!["node", "rotate", "sticky", "strict"].includes(String(document.mode))) {
    throw new Error("代理模式无效");
  }
  if (typeof document.target !== "string") throw new Error("目标 URL 不能为空");
  const target = new URL(document.target);
  if (!["http:", "https:"].includes(target.protocol))
    throw new Error("目标 URL 必须使用 HTTP 或 HTTPS");
  if (document.mode === "node" && (typeof document.node !== "string" || !document.node)) {
    throw new Error("指定节点不能为空");
  }
  return {
    mode: document.mode as PlaygroundRequest["mode"],
    ...(typeof document.node === "string" ? { node: document.node } : {}),
    target: target.href,
  };
}

function executePlaygroundRequest(
  input: PlaygroundRequest & {
    host: string;
    port: number;
    proxyAuthenticationDisabled: boolean;
    proxyToken?: string;
  },
): Promise<{ body: string; durationMs: number; headers: IncomingHttpHeaders; status: number }> {
  if (!input.proxyAuthenticationDisabled && !input.proxyToken) {
    throw new Error("当前 Proxy Token 不可恢复，请通过启动配置重新提供");
  }
  const username =
    input.mode === "node"
      ? `node.${encodeURIComponent(input.node as string)}`
      : input.mode === "rotate"
        ? "rotate"
        : `${input.mode}.playground`;
  const startedAt = Date.now();
  const target = new URL(input.target);
  const authorizationHeaders = input.proxyAuthenticationDisabled
    ? undefined
    : {
        "proxy-authorization": `Basic ${Buffer.from(`${username}:${input.proxyToken}`).toString("base64")}`,
      };
  if (target.protocol === "https:") {
    return new Promise((resolve, reject) => {
      const tunnel = request({
        headers: authorizationHeaders,
        host: input.host,
        method: "CONNECT",
        path: `${target.hostname}:${target.port || 443}`,
        port: input.port,
      });
      tunnel.setTimeout(15_000, () => tunnel.destroy(new Error("请求超时")));
      tunnel.on("error", reject);
      tunnel.on("connect", (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          resolve({
            body: "",
            durationMs: Date.now() - startedAt,
            headers: response.headers,
            status: response.statusCode ?? 502,
          });
          return;
        }
        if (head.length > 0) socket.unshift(head);
        const secureSocket = connectTls({ servername: target.hostname, socket });
        secureSocket.setTimeout(15_000, () => secureSocket.destroy(new Error("请求超时")));
        secureSocket.on("error", reject);
        const tunnelAgent = new HttpsAgent({ keepAlive: false });
        tunnelAgent.createConnection = () => secureSocket;
        const targetRequest = requestHttps(
          {
            agent: tunnelAgent,
            headers: { host: target.host },
            hostname: target.hostname,
            method: "GET",
            path: `${target.pathname}${target.search}`,
            port: target.port || 443,
          },
          (targetResponse) =>
            collectPlaygroundResponse(targetResponse, startedAt).then(resolve, reject),
        );
        targetRequest.setTimeout(15_000, () => targetRequest.destroy(new Error("请求超时")));
        targetRequest.on("error", reject);
        targetRequest.end();
      });
      tunnel.end();
    });
  }
  return new Promise((resolve, reject) => {
    const proxyRequest = request(
      {
        headers: authorizationHeaders,
        host: input.host,
        method: "GET",
        path: input.target,
        port: input.port,
      },
      (proxyResponse) => collectPlaygroundResponse(proxyResponse, startedAt).then(resolve, reject),
    );
    proxyRequest.setTimeout(15_000, () => proxyRequest.destroy(new Error("请求超时")));
    proxyRequest.on("error", reject);
    proxyRequest.end();
  });
}

function collectPlaygroundResponse(
  response: IncomingMessage,
  startedAt: number,
): Promise<{ body: string; durationMs: number; headers: IncomingHttpHeaders; status: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      if (size >= 64 * 1024) return;
      const bounded = chunk.subarray(0, 64 * 1024 - size);
      chunks.push(bounded);
      size += bounded.length;
    });
    response.on("error", reject);
    response.on("end", () =>
      resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        durationMs: Date.now() - startedAt,
        headers: response.headers,
        status: response.statusCode ?? 502,
      }),
    );
  });
}

function parseTargetFeedbackRequest(body: string): {
  nodeId: string;
  outcome: TargetFeedbackOutcome;
  target: string;
  ttlMs?: number;
} {
  const document = JSON.parse(body) as Record<string, unknown>;
  if (typeof document.nodeId !== "string" || typeof document.target !== "string") {
    throw new TargetFeedbackError("nodeId and target are required");
  }
  if (document.outcome !== 403 && document.outcome !== 429 && document.outcome !== "risk") {
    throw new TargetFeedbackError("outcome must be 403, 429, or risk");
  }
  if (document.ttlMs !== undefined && typeof document.ttlMs !== "number") {
    throw new TargetFeedbackError("ttlMs must be a number");
  }
  return {
    nodeId: document.nodeId,
    outcome: document.outcome,
    target: document.target,
    ...(document.ttlMs === undefined ? {} : { ttlMs: document.ttlMs }),
  };
}

function commitProxyTokenMutation<T>(
  registry: ProxyTokenRegistry,
  state: ControlState | undefined,
  mutate: () => T,
): T {
  const checkpoint = registry.persistedSnapshot();
  const result = mutate();
  try {
    state?.saveProxyTokens(registry.persistedSnapshot());
    return result;
  } catch (error) {
    registry.restore(checkpoint);
    throw error;
  }
}

function parseProxyTokenRequest(body: string): string {
  const document = JSON.parse(body) as { token?: unknown };
  if (typeof document.token !== "string" || document.token.length === 0) {
    throw new Error("proxy token is required");
  }
  return document.token;
}

function parseProxyTokenRevocationRequest(body: string): number {
  const document = JSON.parse(body) as { graceMs?: unknown };
  if (!Number.isInteger(document.graceMs) || (document.graceMs as number) < 0) {
    throw new Error("graceMs must be a non-negative integer");
  }
  return document.graceMs as number;
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

function parseNodeEnabledRequest(body: string): boolean {
  try {
    const document = JSON.parse(body) as { enabled?: unknown };
    if (typeof document.enabled !== "boolean") {
      throw new NodeEnabledRequestError("enabled must be a boolean");
    }
    return document.enabled;
  } catch (error) {
    if (error instanceof NodeEnabledRequestError) throw error;
    throw new NodeEnabledRequestError("enabled request must be JSON", { cause: error });
  }
}

class NodeAliasRequestError extends Error {}
class NodeEnabledRequestError extends Error {}

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
  target: string,
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
    connected = await acquirePreconnectedRoute(route, incoming.url ?? "", controller.signal);
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
    connected = await acquirePreconnectedRoute(
      route,
      incoming.url ?? "",
      controller.signal,
      async (socket) => {
        handshake = await performConnectHandshake(
          socket,
          incoming.url ?? "",
          preconnectTimeoutMs,
          controller.signal,
        );
      },
    );
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
  return route.mode === "rotate" || route.mode === "sticky" || route.mode === "node";
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
