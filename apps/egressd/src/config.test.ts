import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";

test("operational settings remain database-backed and public entry URLs default to automatic", () => {
  const config = loadConfig({
    EGRESSKIT_ADMIN_TOKEN: "admin-secret",
    EGRESSKIT_HOST: "0.0.0.0",
    EGRESSKIT_PORT: "9999",
    EGRESSKIT_PROXY_TOKEN: "ignored",
    EGRESSKIT_STATE_DIRECTORY: "/tmp/ignored",
  });
  const stateDirectory = join(homedir(), ".local", "state", "egresskit");
  assert.deepEqual(config, {
    adminToken: "admin-secret",
    publicProxyUrl: "",
    publicRelayUrl: "",
    controlSocketPath: join(stateDirectory, "egressd.sock"),
    stateDirectory,
  });
});

test("admin token is required", () => {
  assert.throws(() => loadConfig({}), /EGRESSKIT_ADMIN_TOKEN is required/);
  assert.throws(() => loadConfig({ EGRESSKIT_ADMIN_TOKEN: "" }), /required/);
});

test("public entry environment variables are normalized without changing listener settings", () => {
  const config = loadConfig({
    EGRESSKIT_ADMIN_TOKEN: "admin-secret",
    EGRESSKIT_PUBLIC_PROXY_URL: " http://proxy.example.com:9797/ ",
    EGRESSKIT_PUBLIC_RELAY_URL: "https://relay.example.com/",
  });
  assert.equal(config.publicProxyUrl, "http://proxy.example.com:9797");
  assert.equal(config.publicRelayUrl, "https://relay.example.com");
  assert.equal(
    loadConfig({ EGRESSKIT_ADMIN_TOKEN: "admin-secret", EGRESSKIT_PUBLIC_PROXY_URL: "  " })
      .publicProxyUrl,
    "",
  );
});

test("invalid public entry URLs fail at startup and identify the environment variable", () => {
  for (const key of ["EGRESSKIT_PUBLIC_PROXY_URL", "EGRESSKIT_PUBLIC_RELAY_URL"]) {
    for (const value of [
      "ftp://proxy.example.com",
      "http://user:secret@proxy.example.com",
      "https://proxy.example.com/path",
      "https://proxy.example.com?token=secret",
      "https://proxy.example.com#fragment",
      "not-a-url",
    ]) {
      assert.throws(
        () => loadConfig({ EGRESSKIT_ADMIN_TOKEN: "admin-secret", [key]: value }),
        new RegExp(key),
      );
    }
  }
});
