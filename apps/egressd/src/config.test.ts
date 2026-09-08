import assert from "node:assert/strict";
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
  });
});

test("proxy authentication can only be disabled safely on loopback", () => {
  assert.equal(loadConfig({ EGRESSKIT_PROXY_AUTH: "disabled" }).proxyAuthentication, false);
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
