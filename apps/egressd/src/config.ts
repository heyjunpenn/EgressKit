import { homedir } from "node:os";
import { join } from "node:path";

import { isLoopbackHost, isLoopbackHttpUrl } from "./network.js";
import type { ProxyAuthentication } from "./proxy-auth.js";

export interface EgressdConfig {
  adminToken?: string;
  allowUnsafeUnauthenticatedProxy?: true;
  controlSocketPath: string;
  healthCheckConcurrency?: number;
  healthCheckIntervalMs?: number;
  healthCheckJitterMs?: number;
  healthCheckSuccessThreshold?: number;
  healthCheckUrls?: readonly URL[];
  host: string;
  port: number;
  mihomoListener?: URL;
  mihomoBinary?: string;
  minimumSubscriptionNodes?: number;
  preconnectAttempts?: number;
  preconnectTimeoutMs?: number;
  proxyAuthentication: ProxyAuthentication;
  sessionAbsoluteTtlMs?: number;
  sessionIdleTimeoutMs?: number;
  sessionMaximumActiveSessions?: number;
  sessionMaximumConcurrentConnections?: number;
  stateDirectory: string;
  targetReputationEnabled?: true;
}

function parseNonNegativeInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoundedPositiveInteger(
  name: string,
  value: string | undefined,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 8787;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("EGRESSKIT_PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv): EgressdConfig {
  const host = environment.EGRESSKIT_HOST ?? "127.0.0.1";
  const listener = environment.EGRESSKIT_MIHOMO_HTTP_LISTENER;
  if (environment.EGRESSKIT_MIHOMO_BINARY === "") {
    throw new Error("EGRESSKIT_MIHOMO_BINARY must not be empty");
  }
  const mihomoListener = listener === undefined ? undefined : new URL(listener);
  if (mihomoListener && !isLoopbackHttpUrl(mihomoListener)) {
    throw new Error("EGRESSKIT_MIHOMO_HTTP_LISTENER must be an HTTP URL using a loopback host");
  }

  const proxyAuthSetting = environment.EGRESSKIT_PROXY_AUTH ?? "enabled";
  if (proxyAuthSetting !== "enabled" && proxyAuthSetting !== "disabled") {
    throw new Error('EGRESSKIT_PROXY_AUTH must be either "enabled" or "disabled"');
  }
  const targetReputationSetting = environment.EGRESSKIT_TARGET_REPUTATION ?? "disabled";
  if (targetReputationSetting !== "enabled" && targetReputationSetting !== "disabled") {
    throw new Error('EGRESSKIT_TARGET_REPUTATION must be either "enabled" or "disabled"');
  }
  const allowUnsafeUnauthenticatedProxy =
    environment.EGRESSKIT_ALLOW_UNSAFE_UNAUTHENTICATED_PROXY === "true";
  if (
    proxyAuthSetting === "disabled" &&
    !isLoopbackHost(host) &&
    !allowUnsafeUnauthenticatedProxy
  ) {
    throw new Error("refusing to disable proxy authentication on a non-loopback host");
  }
  const proxyToken = environment.EGRESSKIT_PROXY_TOKEN;
  if (proxyToken === "") {
    throw new Error("EGRESSKIT_PROXY_TOKEN must not be empty");
  }
  if (environment.EGRESSKIT_STATE_DIRECTORY === "") {
    throw new Error("EGRESSKIT_STATE_DIRECTORY must not be empty");
  }
  const stateDirectory =
    environment.EGRESSKIT_STATE_DIRECTORY ??
    (environment.XDG_STATE_HOME
      ? join(environment.XDG_STATE_HOME, "egresskit")
      : join(homedir(), ".local", "state", "egresskit"));
  const minimumSubscriptionNodes = parsePositiveInteger(
    "EGRESSKIT_MINIMUM_SUBSCRIPTION_NODES",
    environment.EGRESSKIT_MINIMUM_SUBSCRIPTION_NODES,
  );
  const healthCheckUrls = parseHealthCheckUrls(environment.EGRESSKIT_HEALTH_CHECK_URLS);
  const healthCheckSuccessThreshold = parsePositiveInteger(
    "EGRESSKIT_HEALTH_CHECK_SUCCESS_THRESHOLD",
    environment.EGRESSKIT_HEALTH_CHECK_SUCCESS_THRESHOLD,
  );
  if (
    healthCheckSuccessThreshold !== undefined &&
    (healthCheckUrls === undefined || healthCheckSuccessThreshold > healthCheckUrls.length)
  ) {
    throw new Error(
      "EGRESSKIT_HEALTH_CHECK_SUCCESS_THRESHOLD must be within the configured URL count",
    );
  }
  const healthCheckConcurrency = parsePositiveInteger(
    "EGRESSKIT_HEALTH_CHECK_CONCURRENCY",
    environment.EGRESSKIT_HEALTH_CHECK_CONCURRENCY,
  );
  const healthCheckIntervalMs = parsePositiveInteger(
    "EGRESSKIT_HEALTH_CHECK_INTERVAL_MS",
    environment.EGRESSKIT_HEALTH_CHECK_INTERVAL_MS,
  );
  const healthCheckJitterMs = parseNonNegativeInteger(
    "EGRESSKIT_HEALTH_CHECK_JITTER_MS",
    environment.EGRESSKIT_HEALTH_CHECK_JITTER_MS,
  );
  const preconnectAttempts = parseBoundedPositiveInteger(
    "EGRESSKIT_PRECONNECT_ATTEMPTS",
    environment.EGRESSKIT_PRECONNECT_ATTEMPTS,
    10,
  );
  const preconnectTimeoutMs = parseBoundedPositiveInteger(
    "EGRESSKIT_PRECONNECT_TIMEOUT_MS",
    environment.EGRESSKIT_PRECONNECT_TIMEOUT_MS,
    60_000,
  );
  const sessionAbsoluteTtlMs = parsePositiveInteger(
    "EGRESSKIT_SESSION_ABSOLUTE_TTL_MS",
    environment.EGRESSKIT_SESSION_ABSOLUTE_TTL_MS,
  );
  const sessionIdleTimeoutMs = parsePositiveInteger(
    "EGRESSKIT_SESSION_IDLE_TIMEOUT_MS",
    environment.EGRESSKIT_SESSION_IDLE_TIMEOUT_MS,
  );
  const sessionMaximumConcurrentConnections = parsePositiveInteger(
    "EGRESSKIT_SESSION_MAX_CONCURRENT_CONNECTIONS",
    environment.EGRESSKIT_SESSION_MAX_CONCURRENT_CONNECTIONS,
  );
  const sessionMaximumActiveSessions = parsePositiveInteger(
    "EGRESSKIT_MAX_ACTIVE_SESSIONS",
    environment.EGRESSKIT_MAX_ACTIVE_SESSIONS,
  );

  return {
    ...(environment.EGRESSKIT_ADMIN_TOKEN === undefined
      ? {}
      : { adminToken: environment.EGRESSKIT_ADMIN_TOKEN }),
    ...(allowUnsafeUnauthenticatedProxy ? { allowUnsafeUnauthenticatedProxy: true as const } : {}),
    controlSocketPath: environment.EGRESSKIT_CONTROL_SOCKET ?? join(stateDirectory, "egressd.sock"),
    host,
    ...(healthCheckConcurrency === undefined ? {} : { healthCheckConcurrency }),
    ...(healthCheckIntervalMs === undefined ? {} : { healthCheckIntervalMs }),
    ...(healthCheckJitterMs === undefined ? {} : { healthCheckJitterMs }),
    ...(healthCheckSuccessThreshold === undefined ? {} : { healthCheckSuccessThreshold }),
    ...(healthCheckUrls === undefined ? {} : { healthCheckUrls }),
    ...(minimumSubscriptionNodes === undefined ? {} : { minimumSubscriptionNodes }),
    port: parsePort(environment.EGRESSKIT_PORT),
    ...(preconnectAttempts === undefined ? {} : { preconnectAttempts }),
    ...(preconnectTimeoutMs === undefined ? {} : { preconnectTimeoutMs }),
    stateDirectory,
    ...(targetReputationSetting === "enabled" ? { targetReputationEnabled: true as const } : {}),
    ...(mihomoListener === undefined ? {} : { mihomoListener }),
    ...(environment.EGRESSKIT_MIHOMO_BINARY === undefined
      ? {}
      : { mihomoBinary: environment.EGRESSKIT_MIHOMO_BINARY }),
    proxyAuthentication:
      proxyAuthSetting === "disabled"
        ? false
        : { tokens: proxyToken === undefined ? [] : [proxyToken] },
    ...(sessionAbsoluteTtlMs === undefined ? {} : { sessionAbsoluteTtlMs }),
    ...(sessionIdleTimeoutMs === undefined ? {} : { sessionIdleTimeoutMs }),
    ...(sessionMaximumActiveSessions === undefined ? {} : { sessionMaximumActiveSessions }),
    ...(sessionMaximumConcurrentConnections === undefined
      ? {}
      : { sessionMaximumConcurrentConnections }),
  };
}

function parseHealthCheckUrls(value: string | undefined): readonly URL[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new Error("EGRESSKIT_HEALTH_CHECK_URLS must contain at least one URL");
  }
  const urls = entries.map((entry) => new URL(entry));
  if (urls.some((url) => url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("EGRESSKIT_HEALTH_CHECK_URLS entries must use HTTP or HTTPS");
  }
  return urls;
}
