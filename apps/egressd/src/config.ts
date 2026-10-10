import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BootstrapConfig {
  adminToken: string;
  controlSocketPath: string;
  publicProxyUrl: string;
  publicRelayUrl: string;
  stateDirectory: string;
  webDirectory?: string;
}

export function defaultStateDirectory(): string {
  if (existsSync("/var/lib/egresskit")) return "/var/lib/egresskit";
  return join(homedir(), ".local", "state", "egresskit");
}

export function loadConfig(environment: NodeJS.ProcessEnv): BootstrapConfig {
  const adminToken = environment.EGRESSKIT_ADMIN_TOKEN;
  if (!adminToken) throw new Error("EGRESSKIT_ADMIN_TOKEN is required");
  const stateDirectory = defaultStateDirectory();
  const packagedWeb = "/opt/egresskit/web";
  return {
    adminToken,
    publicProxyUrl: normalizePublicEndpoint(
      environment.EGRESSKIT_PUBLIC_PROXY_URL ?? "",
      "EGRESSKIT_PUBLIC_PROXY_URL",
    ),
    publicRelayUrl: normalizePublicEndpoint(
      environment.EGRESSKIT_PUBLIC_RELAY_URL ?? "",
      "EGRESSKIT_PUBLIC_RELAY_URL",
    ),
    controlSocketPath: join(stateDirectory, "egressd.sock"),
    stateDirectory,
    ...(existsSync(packagedWeb) ? { webDirectory: packagedWeb } : {}),
  };
}

export function normalizePublicEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串`);
  const input = value.trim();
  if (!input) return "";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label}请输入完整的 http:// 或 https:// 地址`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label}只支持 http:// 或 https:// 域名及端口，不包含认证信息、路径或查询参数`,
    );
  }
  return url.origin;
}
