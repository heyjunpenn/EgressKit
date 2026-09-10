import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BootstrapConfig {
  adminToken: string;
  controlSocketPath: string;
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
    controlSocketPath: join(stateDirectory, "egressd.sock"),
    stateDirectory,
    ...(existsSync(packagedWeb) ? { webDirectory: packagedWeb } : {}),
  };
}
