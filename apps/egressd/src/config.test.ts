import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "./config.js";

test("the simulated Mihomo listener must use a loopback host", () => {
  assert.throws(
    () => loadConfig({ EGRESSKIT_MIHOMO_HTTP_LISTENER: "http://192.0.2.10:7890" }),
    /loopback host/,
  );
  assert.equal(
    loadConfig({ EGRESSKIT_MIHOMO_HTTP_LISTENER: "http://[::1]:7890" }).mihomoListener?.hostname,
    "[::1]",
  );
});

test("an existing Mihomo binary path is passed through explicitly", () => {
  assert.equal(loadConfig({ EGRESSKIT_MIHOMO_BINARY: "/opt/mihomo" }).mihomoBinary, "/opt/mihomo");
  assert.throws(() => loadConfig({ EGRESSKIT_MIHOMO_BINARY: "" }), /must not be empty/);
});

test("proxy authentication is enabled by default", () => {
  assert.deepEqual(loadConfig({}), {
    controlSocketPath: join(homedir(), ".local", "state", "egresskit", "egressd.sock"),
    host: "127.0.0.1",
    port: 8787,
    proxyAuthentication: { tokens: [] },
    stateDirectory: join(homedir(), ".local", "state", "egresskit"),
  });
});

test("proxy authentication can only be disabled safely on loopback", () => {
  assert.equal(loadConfig({ EGRESSKIT_PROXY_AUTH: "disabled" }).proxyAuthentication, false);
  assert.equal(
    loadConfig({ EGRESSKIT_HOST: "::1", EGRESSKIT_PROXY_AUTH: "disabled" }).proxyAuthentication,
    false,
  );
  assert.equal(
    loadConfig({
      EGRESSKIT_HOST: "0:0:0:0:0:0:0:1",
      EGRESSKIT_PROXY_AUTH: "disabled",
    }).proxyAuthentication,
    false,
  );
  assert.throws(
    () =>
      loadConfig({
        EGRESSKIT_HOST: "0.0.0.0",
        EGRESSKIT_PROXY_AUTH: "disabled",
      }),
    /refusing to disable proxy authentication on a non-loopback host/,
  );
  assert.deepEqual(
    loadConfig({
      EGRESSKIT_ALLOW_UNSAFE_UNAUTHENTICATED_PROXY: "true",
      EGRESSKIT_HOST: "0.0.0.0",
      EGRESSKIT_PROXY_AUTH: "disabled",
    }).proxyAuthentication,
    false,
  );
});

test("proxy token configures data-plane authentication", () => {
  const config = loadConfig({ EGRESSKIT_PROXY_TOKEN: "proxy-secret" });

  assert.deepEqual(config.proxyAuthentication, { tokens: ["proxy-secret"] });
});

test("target reputation is disabled by default and requires an explicit enable", () => {
  assert.equal(loadConfig({}).targetReputationEnabled, undefined);
  assert.equal(
    loadConfig({ EGRESSKIT_TARGET_REPUTATION: "enabled" }).targetReputationEnabled,
    true,
  );
  assert.throws(
    () => loadConfig({ EGRESSKIT_TARGET_REPUTATION: "true" }),
    /EGRESSKIT_TARGET_REPUTATION must be either "enabled" or "disabled"/,
  );
});

test("state directory configures durable daemon control state", () => {
  assert.equal(
    loadConfig({ EGRESSKIT_STATE_DIRECTORY: "/var/lib/egresskit" }).stateDirectory,
    "/var/lib/egresskit",
  );
  assert.throws(() => loadConfig({ EGRESSKIT_STATE_DIRECTORY: "" }), /must not be empty/);
  assert.equal(loadConfig({ XDG_STATE_HOME: "/tmp/state" }).stateDirectory, "/tmp/state/egresskit");
});

test("minimum subscription nodes is a positive configurable integer", () => {
  assert.equal(
    loadConfig({ EGRESSKIT_MINIMUM_SUBSCRIPTION_NODES: "3" }).minimumSubscriptionNodes,
    3,
  );
  for (const value of ["0", "-1", "1.5", "many"]) {
    assert.throws(
      () => loadConfig({ EGRESSKIT_MINIMUM_SUBSCRIPTION_NODES: value }),
      /positive integer/,
    );
  }
});

test("pre-connect failover attempts and timeout are configurable within hard bounds", () => {
  assert.deepEqual(
    loadConfig({
      EGRESSKIT_PRECONNECT_ATTEMPTS: "4",
      EGRESSKIT_PRECONNECT_TIMEOUT_MS: "2500",
    }),
    {
      controlSocketPath: join(homedir(), ".local", "state", "egresskit", "egressd.sock"),
      host: "127.0.0.1",
      port: 8787,
      preconnectAttempts: 4,
      preconnectTimeoutMs: 2_500,
      proxyAuthentication: { tokens: [] },
      stateDirectory: join(homedir(), ".local", "state", "egresskit"),
    },
  );
  for (const value of ["0", "11", "1.5", "many"]) {
    assert.throws(() => loadConfig({ EGRESSKIT_PRECONNECT_ATTEMPTS: value }), /between 1 and 10/);
  }
  for (const value of ["0", "60001", "1.5", "many"]) {
    assert.throws(
      () => loadConfig({ EGRESSKIT_PRECONNECT_TIMEOUT_MS: value }),
      /between 1 and 60000/,
    );
  }
});

test("session resource limits and expirations are configurable positive integers", () => {
  assert.deepEqual(
    loadConfig({
      EGRESSKIT_MAX_ACTIVE_SESSIONS: "100",
      EGRESSKIT_SESSION_ABSOLUTE_TTL_MS: "1800000",
      EGRESSKIT_SESSION_IDLE_TIMEOUT_MS: "300000",
      EGRESSKIT_SESSION_MAX_CONCURRENT_CONNECTIONS: "50",
    }),
    {
      controlSocketPath: join(homedir(), ".local", "state", "egresskit", "egressd.sock"),
      host: "127.0.0.1",
      port: 8787,
      proxyAuthentication: { tokens: [] },
      sessionAbsoluteTtlMs: 1_800_000,
      sessionIdleTimeoutMs: 300_000,
      sessionMaximumActiveSessions: 100,
      sessionMaximumConcurrentConnections: 50,
      stateDirectory: join(homedir(), ".local", "state", "egresskit"),
    },
  );

  for (const name of [
    "EGRESSKIT_MAX_ACTIVE_SESSIONS",
    "EGRESSKIT_SESSION_ABSOLUTE_TTL_MS",
    "EGRESSKIT_SESSION_IDLE_TIMEOUT_MS",
    "EGRESSKIT_SESSION_MAX_CONCURRENT_CONNECTIONS",
  ]) {
    assert.throws(() => loadConfig({ [name]: "0" }), /positive integer/);
  }
});

test("node health targets, threshold, concurrency, interval, and jitter are configurable", () => {
  const config = loadConfig({
    EGRESSKIT_HEALTH_CHECK_CONCURRENCY: "3",
    EGRESSKIT_HEALTH_CHECK_INTERVAL_MS: "45000",
    EGRESSKIT_HEALTH_CHECK_JITTER_MS: "2500",
    EGRESSKIT_HEALTH_CHECK_SUCCESS_THRESHOLD: "2",
    EGRESSKIT_HEALTH_CHECK_URLS: "https://one.example/health, http://two.example/status",
  });

  assert.deepEqual(config.healthCheckUrls?.map(String), [
    "https://one.example/health",
    "http://two.example/status",
  ]);
  assert.equal(config.healthCheckSuccessThreshold, 2);
  assert.equal(config.healthCheckConcurrency, 3);
  assert.equal(config.healthCheckIntervalMs, 45_000);
  assert.equal(config.healthCheckJitterMs, 2_500);
  assert.throws(
    () => loadConfig({ EGRESSKIT_HEALTH_CHECK_URLS: "ftp://invalid.example" }),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        EGRESSKIT_HEALTH_CHECK_SUCCESS_THRESHOLD: "2",
        EGRESSKIT_HEALTH_CHECK_URLS: "https://only.example",
      }),
    /within the configured URL count/,
  );
});
