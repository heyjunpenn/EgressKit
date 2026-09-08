import assert from "node:assert/strict";
import test from "node:test";

import { cleanChildEnvironment, isVerifiedExit, validateTargetUrl } from "./live-vless.mjs";

test("live target must be HTTPS and both observed values must be distinct IP addresses", () => {
  assert.throws(() => validateTargetUrl("http://target.example/json"), /HTTPS/);
  assert.equal(validateTargetUrl("https://target.example/json").protocol, "https:");
  assert.equal(isVerifiedExit("direct", "proxy"), false);
  assert.equal(isVerifiedExit("192.0.2.1", "192.0.2.1"), false);
  assert.equal(isVerifiedExit("192.0.2.1", "2001:db8::1"), true);
});

test("live secrets are not inherited by daemon, CLI, Mihomo, or curl", () => {
  assert.deepEqual(
    cleanChildEnvironment({
      EGRESSKIT_LIVE_SUBSCRIPTION_URL: "secret",
      EGRESSKIT_LIVE_TARGET_URL: "https://target.example",
      EGRESSKIT_MIHOMO_HTTP_LISTENER: "http://127.0.0.1:9999",
      EGRESSKIT_CONTROL_SOCKET: "/wrong/socket",
      PATH: "/bin",
    }),
    { PATH: "/bin" },
  );
});
