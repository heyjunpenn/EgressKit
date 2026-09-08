import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeProxyRequest } from "./proxy-auth.js";

const authentication = { tokens: ["proxy-secret"] };

function authorization(username: string): string {
  return `Basic ${Buffer.from(`${username}:proxy-secret`).toString("base64")}`;
}

test("proxy usernames expose structured scheduling routes", () => {
  assert.deepEqual(authorizeProxyRequest(authorization("rotate"), authentication), {
    mode: "rotate",
  });
  assert.deepEqual(authorizeProxyRequest(authorization("sticky.session-a"), authentication), {
    mode: "sticky",
    sessionKey: "session-a",
  });
  assert.deepEqual(authorizeProxyRequest(authorization("strict.session-b"), authentication), {
    mode: "strict",
    sessionKey: "session-b",
  });
  assert.deepEqual(authorizeProxyRequest(authorization("node.exit-alias"), authentication), {
    mode: "node",
    selector: "exit-alias",
  });
  assert.deepEqual(authorizeProxyRequest(authorization("node.local%3Aprimary"), authentication), {
    mode: "node",
    selector: "local:primary",
  });
});
