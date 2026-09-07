import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";

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
