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

test("proxy authentication is enabled by default", () => {
  assert.deepEqual(loadConfig({}), {
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

test("session resource limits and expirations are configurable positive integers", () => {
  assert.deepEqual(
    loadConfig({
      EGRESSKIT_MAX_ACTIVE_SESSIONS: "100",
      EGRESSKIT_SESSION_ABSOLUTE_TTL_MS: "1800000",
      EGRESSKIT_SESSION_IDLE_TIMEOUT_MS: "300000",
      EGRESSKIT_SESSION_MAX_CONCURRENT_CONNECTIONS: "50",
    }),
    {
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
