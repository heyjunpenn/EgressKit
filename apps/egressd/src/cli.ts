#!/usr/bin/env node

import { join } from "node:path";

import { loadConfig } from "./config.js";
import { startEgressd } from "./daemon.js";
import { resolveExitIpThroughMihomo } from "./health.js";
import { resolveMihomoBinary } from "./mihomo-install.js";
import { checkMihomoConfig, ManagedMihomoRuntime } from "./mihomo-runtime.js";
import { openControlState } from "./state.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const settingsState = await openControlState(config.stateDirectory);
  const settings = settingsState.loadRuntimeSettings(config.adminToken);
  await settingsState.close();
  const mihomoBinary = await resolveMihomoBinary(
    config.stateDirectory,
    settings.mihomoBinary || undefined,
  );
  const mihomoRuntime = !settings.mihomoHttpListener
    ? new ManagedMihomoRuntime({
        binary: mihomoBinary,
        directory: join(config.stateDirectory, "mihomo-runtime"),
      })
    : {
        apply: async (mihomoConfig: Parameters<typeof checkMihomoConfig>[0]) => {
          if (mihomoConfig.proxies.length !== 1) {
            throw new Error("configured Mihomo listener supports exactly one imported node");
          }
          const node = mihomoConfig.proxies[0];
          return new Map(node ? [[node.name, new URL(settings.mihomoHttpListener)]] : []);
        },
        check: (mihomoConfig: Parameters<typeof checkMihomoConfig>[0]) =>
          checkMihomoConfig(mihomoConfig, { binary: mihomoBinary }),
        removeListener: async () => {
          throw new Error("the configured external Mihomo listener cannot be removed");
        },
      };
  const daemon = await startEgressd({
    adminToken: config.adminToken,
    exitIpCheckBatchSize: settings.exitIpCheckBatchSize,
    controlSocketPath: config.controlSocketPath,
    stateDirectory: config.stateDirectory,
    ...(config.webDirectory ? { webDirectory: config.webDirectory } : {}),
    host: settings.host,
    port: settings.port,
    ...(settings.mihomoHttpListener
      ? { mihomoListener: new URL(settings.mihomoHttpListener) }
      : {}),
    proxyAuthentication: settings.proxyAuthEnabled ? { tokens: [settings.proxyToken] } : false,
    healthCheckConcurrency: settings.healthCheckConcurrency,
    healthCheckIntervalMs: settings.healthCheckIntervalMs,
    healthCheckJitterMs: settings.healthCheckJitterMs,
    healthCheckSuccessThreshold: settings.healthCheckSuccessThreshold,
    healthCheckUrls: settings.healthCheckUrls.map((url) => new URL(url)),
    exitIpProbe: resolveExitIpThroughMihomo,
    minimumSubscriptionNodes: settings.minimumSubscriptionNodes,
    preconnectAttempts: settings.preconnectAttempts,
    preconnectTimeoutMs: settings.preconnectTimeoutMs,
    remoteSubscriptionRefreshIntervalMs: settings.remoteSubscriptionRefreshIntervalMs,
    sessionAbsoluteTtlMs: settings.sessionAbsoluteTtlMs,
    sessionIdleTimeoutMs: settings.sessionIdleTimeoutMs,
    sessionMaximumActiveSessions: settings.sessionMaximumActiveSessions,
    sessionMaximumConcurrentConnections: settings.sessionMaximumConcurrentConnections,
    targetReputationEnabled: settings.targetReputationEnabled,
    mihomoRuntime,
  });

  process.stdout.write(`${JSON.stringify({ event: "egressd.started", ...daemon.address })}\n`);

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  await daemon.close();
  process.stdout.write(`${JSON.stringify({ event: "egressd.stopped", signal })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ event: "egressd.failed", message })}\n`);
  process.exitCode = 1;
});
