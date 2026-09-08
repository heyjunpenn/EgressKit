import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

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
  openControlState,
  type PersistedNodeGeneration,
  RevisionForceConflictError,
} from "./state.js";
import { type ImportedVlessRevision, importLocalVlessYaml } from "./subscription.js";

export interface MihomoRuntime {
  apply(config: ImportedVlessRevision["mihomoConfig"]): Promise<ReadonlyMap<string, URL>>;
}

export interface EgressdOptions {
  adminToken?: string;
  allowUnsafeUnauthenticatedProxy?: boolean;
  checkMihomoListener?: (listener: URL) => Promise<void>;
  fetchSubscription?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  host: string;
  log?: (event: EgressdLogEvent) => void;
  mihomoListener?: URL;
  mihomoRuntime?: MihomoRuntime;
  minimumSubscriptionNodes?: number;
  port: number;
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
  close(): Promise<void>;
  importLocalSubscription(source: string): Promise<ImportedVlessRevision>;
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

export async function startEgressd(options: EgressdOptions): Promise<RunningEgressd> {
  validateRemoteSubscriptionTimeout(options.remoteSubscriptionTimeoutMs);
  validateMinimumSubscriptionNodes(options.minimumSubscriptionNodes);
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
  const state = options.stateDirectory ? await openControlState(options.stateDirectory) : undefined;
  const withControlPlaneLock = createAsyncLock();
  let softStickySessions: SoftStickySessions;
  try {
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
    await state?.close();
    throw error;
  }

  const acquireRoute = (route: ProxyRoute) => {
    if (route.mode === "rotate") {
      return scheduler.acquire();
    }
    if (route.mode === "sticky") {
      return softStickySessions.acquire(route.sessionKey);
    }
    if (route.mode === "strict") {
      return softStickySessions.acquireStrict(route.sessionKey);
    }
    if (route.mode === "node") {
      return scheduler.acquireBySelector(route.selector);
    }
    return "not-implemented" as const;
  };

  const activateRevisionUnlocked = async (
    revision: ImportedVlessRevision,
    persistedNodes?: readonly PersistedNodeGeneration[],
    logicalIdPrefix = "local",
    checking?: () => void,
  ): Promise<void> => {
    if (!options.mihomoRuntime) {
      throw new Error("Mihomo runtime is not configured");
    }
    const identities = revision.nodes.map((node) => ({
      id:
        persistedNodes?.find((persisted) => persisted.node.name === node.name)?.logicalId ??
        `${logicalIdPrefix}:${node.name}`,
      node,
    }));
    let aliases = state?.getNodeAliases() ?? new Map<string, string>();
    validateSelectorUniqueness(
      identities.map(({ id }) => ({ id })),
      [...aliases.values()],
    );
    const listeners = await options.mihomoRuntime.apply(revision.mihomoConfig);
    checking?.();
    for (const node of revision.nodes) {
      const listener = listeners.get(node.name);
      if (!listener || !isLoopbackHttpUrl(listener)) {
        throw new Error(`Mihomo runtime did not start a loopback listener for ${node.name}`);
      }
      await (options.checkMihomoListener ?? checkListenerReady)(listener);
    }
    aliases = state?.getNodeAliases() ?? aliases;
    validateSelectorUniqueness(
      identities.map(({ id }) => ({ id })),
      [...aliases.values()],
    );
    scheduler.replaceCandidates(
      identities.map(({ id, node }) => {
        const alias = aliases.get(id);
        return createSchedulerCandidate(
          id,
          listeners.get(node.name) as URL,
          options.schedulerSignals?.get(id),
          alias === undefined ? [] : [alias],
        );
      }),
    );
  };

  try {
    const restored = state?.loadActiveRevision();
    if (restored) {
      await withControlPlaneLock(() => activateRevisionUnlocked(restored.imported, restored.nodes));
    }
  } catch (error) {
    await state?.close();
    throw error;
  }

  const importLocalSubscription = async (source: string): Promise<ImportedVlessRevision> => {
    const revision = importLocalVlessYaml(source, { firstListenerPort: 20_000 });
    if (revision.nodes.length === 0) {
      throw new Error("subscription contains no VLESS nodes");
    }
    await withControlPlaneLock(async () => {
      await activateRevisionUnlocked(revision);
      state?.saveActiveRevision({
        imported: revision,
        source: { id: "local", kind: "local", locator: "inline" },
      });
    });
    return revision;
  };

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

  const server = createServer((incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "live" }));
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
    let lease: SchedulerLease | "not-implemented" | undefined;
    try {
      lease = acquireRoute(route);
    } catch (error) {
      if (error instanceof SessionCapacityError) {
        response.writeHead(429);
        response.end();
        return;
      }
      response.writeHead(503);
      response.end();
      return;
    }
    if (lease === "not-implemented") {
      response.writeHead(501);
      response.end();
      return;
    }
    if (!lease) {
      response.writeHead(502);
      response.end();
      return;
    }

    const { "proxy-authorization": _proxyAuthorization, ...forwardedHeaders } = incoming.headers;
    const upstream = request(
      lease.candidate.listener,
      {
        headers: {
          ...forwardedHeaders,
          via: appendVia(incoming.headers.via, "1.1 egresskit"),
        },
        method: incoming.method,
        path: incoming.url,
      },
      (upstreamResponse) => {
        upstreamResponse.once("close", lease.release);
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      lease.release();
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
    response.once("close", lease.release);
    incoming.pipe(upstream);
  });
  server.on("connect", (incoming, clientSocket, head) => {
    const route = authorizeProxyRequest(
      incoming.headers["proxy-authorization"],
      options.proxyAuthentication,
    );
    if (route === undefined) {
      rejectConnectProxyAuthentication(clientSocket);
      return;
    }
    let lease: SchedulerLease | "not-implemented" | undefined;
    try {
      lease = acquireRoute(route);
    } catch (error) {
      if (error instanceof SessionCapacityError) {
        clientSocket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        return;
      }
      clientSocket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    if (lease === "not-implemented") {
      clientSocket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
      return;
    }
    if (!lease) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    clientSocket.once("close", lease.release);
    handleConnect(incoming, clientSocket, head, lease.candidate.listener);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await state?.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    await state?.close();
    throw new Error("egressd did not bind a TCP address");
  }

  let closed = false;
  return {
    address: { host: options.host, port: address.port },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      remoteOperations?.close();
      try {
        await closeServer(server);
      } finally {
        await state?.close();
      }
    },
    importLocalSubscription,
  };
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
  const url = new URL(document.url);
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

function handleConnect(
  incoming: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  mihomoListener: URL | undefined,
): void {
  if (!mihomoListener || !incoming.url) {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }

  const listenerPort = Number(mihomoListener.port || 80);
  const listenerSocket = connect(listenerPort, mihomoListener.hostname);
  let tunnelEstablished = false;
  listenerSocket.on("connect", () => {
    listenerSocket.write(
      `CONNECT ${incoming.url} HTTP/1.1\r\nHost: ${incoming.url}\r\nVia: 1.1 egresskit\r\n\r\n`,
    );
  });

  let responseHead = Buffer.alloc(0);
  const receiveResponseHead = (chunk: Buffer): void => {
    responseHead = Buffer.concat([responseHead, chunk]);
    const end = responseHead.indexOf("\r\n\r\n");
    if (end === -1) {
      if (responseHead.length > 64 * 1024) {
        listenerSocket.destroy(new Error("Mihomo CONNECT response headers are too large"));
      }
      return;
    }

    listenerSocket.off("data", receiveResponseHead);
    const header = responseHead.subarray(0, end + 4);
    const remaining = responseHead.subarray(end + 4);
    clientSocket.write(header);
    if (!header.toString("latin1").startsWith("HTTP/1.1 200")) {
      clientSocket.end(remaining);
      listenerSocket.end();
      return;
    }

    tunnelEstablished = true;
    if (head.length > 0) {
      listenerSocket.write(head);
    }
    if (remaining.length > 0) {
      clientSocket.write(remaining);
    }
    clientSocket.pipe(listenerSocket);
    listenerSocket.pipe(clientSocket);
  };
  listenerSocket.on("data", receiveResponseHead);
  listenerSocket.on("error", () => {
    if (!clientSocket.destroyed) {
      if (tunnelEstablished) {
        clientSocket.destroy();
      } else {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
    }
  });
  clientSocket.on("error", () => listenerSocket.destroy());
  clientSocket.once("close", () => listenerSocket.destroy());
  listenerSocket.once("close", () => clientSocket.destroy());
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
