import { isLoopbackHost, isLoopbackHttpUrl } from "./network.js";

export interface RuntimeSettings {
  exitIpCheckBatchSize: number;
  healthCheckConcurrency: number;
  healthCheckIntervalMs: number;
  healthCheckJitterMs: number;
  healthCheckSuccessThreshold: number;
  healthCheckUrls: string[];
  host: string;
  mihomoBinary: string;
  mihomoHttpListener: string;
  minimumSubscriptionNodes: number;
  port: number;
  preconnectAttempts: number;
  preconnectTimeoutMs: number;
  proxyAuthEnabled: boolean;
  proxyToken: string;
  remoteSubscriptionRefreshIntervalMs: number;
  sessionAbsoluteTtlMs: number;
  sessionIdleTimeoutMs: number;
  sessionMaximumActiveSessions: number;
  sessionMaximumConcurrentConnections: number;
  targetReputationEnabled: boolean;
}

export const restartRequiredSettingFields: readonly (keyof RuntimeSettings)[] = [
  "exitIpCheckBatchSize",
  "healthCheckConcurrency",
  "healthCheckIntervalMs",
  "healthCheckJitterMs",
  "healthCheckSuccessThreshold",
  "healthCheckUrls",
  "host",
  "mihomoBinary",
  "mihomoHttpListener",
  "minimumSubscriptionNodes",
  "port",
  "preconnectAttempts",
  "preconnectTimeoutMs",
  "proxyAuthEnabled",
  "remoteSubscriptionRefreshIntervalMs",
  "sessionAbsoluteTtlMs",
  "sessionIdleTimeoutMs",
  "sessionMaximumActiveSessions",
  "sessionMaximumConcurrentConnections",
  "targetReputationEnabled",
];

export function defaultRuntimeSettings(adminToken: string): RuntimeSettings {
  return {
    exitIpCheckBatchSize: 10,
    healthCheckConcurrency: 4,
    healthCheckIntervalMs: 30_000,
    healthCheckJitterMs: 5_000,
    healthCheckSuccessThreshold: 1,
    healthCheckUrls: ["https://www.gstatic.com/generate_204"],
    host: "0.0.0.0",
    mihomoBinary: "",
    mihomoHttpListener: "",
    minimumSubscriptionNodes: 1,
    port: 8787,
    preconnectAttempts: 3,
    preconnectTimeoutMs: 10_000,
    proxyAuthEnabled: true,
    proxyToken: adminToken,
    remoteSubscriptionRefreshIntervalMs: 600_000,
    sessionAbsoluteTtlMs: 1_800_000,
    sessionIdleTimeoutMs: 300_000,
    sessionMaximumActiveSessions: 10_000,
    sessionMaximumConcurrentConnections: 50,
    targetReputationEnabled: false,
  };
}

export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("settings must be an object");
  const input = value as Record<string, unknown>;
  const string = (key: keyof RuntimeSettings) => {
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string`);
    return input[key] as string;
  };
  const boolean = (key: keyof RuntimeSettings) => {
    if (typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    return input[key] as boolean;
  };
  const integer = (
    key: keyof RuntimeSettings,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ) => {
    const candidate = input[key];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < minimum ||
      (candidate as number) > maximum
    ) {
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate as number;
  };
  const urls = input.healthCheckUrls;
  if (!Array.isArray(urls) || urls.length < 1 || urls.some((url) => typeof url !== "string")) {
    throw new Error("healthCheckUrls must contain at least one URL");
  }
  for (const candidate of urls as string[]) {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("healthCheckUrls must use HTTP or HTTPS");
  }
  const settings: RuntimeSettings = {
    exitIpCheckBatchSize: integer("exitIpCheckBatchSize", 1, 10_000),
    healthCheckConcurrency: integer("healthCheckConcurrency", 1, 100),
    healthCheckIntervalMs: integer("healthCheckIntervalMs", 1_000),
    healthCheckJitterMs: integer("healthCheckJitterMs", 0),
    healthCheckSuccessThreshold: integer("healthCheckSuccessThreshold", 1, urls.length),
    healthCheckUrls: [...urls] as string[],
    host: string("host"),
    mihomoBinary: string("mihomoBinary"),
    mihomoHttpListener: string("mihomoHttpListener"),
    minimumSubscriptionNodes: integer("minimumSubscriptionNodes", 1),
    port: integer("port", 0, 65_535),
    preconnectAttempts: integer("preconnectAttempts", 1, 10),
    preconnectTimeoutMs: integer("preconnectTimeoutMs", 1, 60_000),
    proxyAuthEnabled: boolean("proxyAuthEnabled"),
    proxyToken: string("proxyToken"),
    remoteSubscriptionRefreshIntervalMs: integer("remoteSubscriptionRefreshIntervalMs", 60_000),
    sessionAbsoluteTtlMs: integer("sessionAbsoluteTtlMs", 1),
    sessionIdleTimeoutMs: integer("sessionIdleTimeoutMs", 1),
    sessionMaximumActiveSessions: integer("sessionMaximumActiveSessions", 1),
    sessionMaximumConcurrentConnections: integer("sessionMaximumConcurrentConnections", 1),
    targetReputationEnabled: boolean("targetReputationEnabled"),
  };
  if (!settings.host) throw new Error("host must not be empty");
  if (settings.proxyAuthEnabled && !settings.proxyToken)
    throw new Error("proxyToken must not be empty when authentication is enabled");
  if (settings.mihomoHttpListener && !isLoopbackHttpUrl(new URL(settings.mihomoHttpListener))) {
    throw new Error("mihomoHttpListener must be a loopback HTTP URL");
  }
  if (!settings.proxyAuthEnabled && !isLoopbackHost(settings.host)) {
    throw new Error("proxy authentication can only be disabled on a loopback host");
  }
  return settings;
}
