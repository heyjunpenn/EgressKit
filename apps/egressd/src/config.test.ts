import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";

test("admin token is the only EgressKit environment setting", () => {
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
    controlSocketPath: join(stateDirectory, "egressd.sock"),
    stateDirectory,
  });
});

test("admin token is required", () => {
  assert.throws(() => loadConfig({}), /EGRESSKIT_ADMIN_TOKEN is required/);
  assert.throws(() => loadConfig({ EGRESSKIT_ADMIN_TOKEN: "" }), /required/);
});
