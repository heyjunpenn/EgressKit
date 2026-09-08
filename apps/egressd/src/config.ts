import { isLoopbackHost, isLoopbackHttpUrl } from "./network.js";
import type { ProxyAuthentication } from "./proxy-auth.js";

export interface EgressdConfig {
  adminToken?: string;
  allowUnsafeUnauthenticatedProxy?: true;
  host: string;
  port: number;
  mihomoListener?: URL;
  proxyAuthentication: ProxyAuthentication;
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
  const mihomoListener = listener === undefined ? undefined : new URL(listener);
  if (mihomoListener && !isLoopbackHttpUrl(mihomoListener)) {
    throw new Error("EGRESSKIT_MIHOMO_HTTP_LISTENER must be an HTTP URL using a loopback host");
  }

  const proxyAuthSetting = environment.EGRESSKIT_PROXY_AUTH ?? "enabled";
  if (proxyAuthSetting !== "enabled" && proxyAuthSetting !== "disabled") {
    throw new Error('EGRESSKIT_PROXY_AUTH must be either "enabled" or "disabled"');
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

  return {
    ...(environment.EGRESSKIT_ADMIN_TOKEN === undefined
      ? {}
      : { adminToken: environment.EGRESSKIT_ADMIN_TOKEN }),
    ...(allowUnsafeUnauthenticatedProxy ? { allowUnsafeUnauthenticatedProxy: true as const } : {}),
    host,
    port: parsePort(environment.EGRESSKIT_PORT),
    ...(mihomoListener === undefined ? {} : { mihomoListener }),
    proxyAuthentication:
      proxyAuthSetting === "disabled"
        ? false
        : { tokens: proxyToken === undefined ? [] : [proxyToken] },
  };
}
