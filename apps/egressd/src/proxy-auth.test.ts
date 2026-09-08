import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeProxyRequest, ProxyTokenRegistry } from "./proxy-auth.js";

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

test("proxy tokens overlap during a bounded revocation grace period without being exposed", () => {
  let now = 1_000;
  const registry = new ProxyTokenRegistry({ initialTokens: ["old-secret"], now: () => now });
  const oldId = registry.snapshot()[0]?.id as string;
  const oldAuthorization = `Basic ${Buffer.from("rotate:old-secret").toString("base64")}`;
  const added = registry.add("new-secret");
  const newAuthorization = `Basic ${Buffer.from("rotate:new-secret").toString("base64")}`;

  assert.deepEqual(authorizeProxyRequest(oldAuthorization, registry), { mode: "rotate" });
  assert.deepEqual(authorizeProxyRequest(newAuthorization, registry), { mode: "rotate" });
  assert.equal(registry.revoke("missing", 5_000), undefined);
  assert.deepEqual(registry.revoke(oldId, 5_000), { expiresAt: 6_000, status: "grace" });
  assert.deepEqual(authorizeProxyRequest(oldAuthorization, registry), { mode: "rotate" });
  now += 4_999;
  assert.deepEqual(authorizeProxyRequest(oldAuthorization, registry), { mode: "rotate" });
  now += 1;
  assert.equal(authorizeProxyRequest(oldAuthorization, registry), undefined);
  assert.deepEqual(authorizeProxyRequest(newAuthorization, registry), { mode: "rotate" });

  const serialized = JSON.stringify({ added, tokens: registry.snapshot() });
  assert.doesNotMatch(serialized, /old-secret|new-secret|Basic|Proxy-Authorization/i);
});

test("empty proxy passwords are ordinary authentication failures", () => {
  const registry = new ProxyTokenRegistry({ initialTokens: ["proxy-secret"] });
  const emptyPassword = `Basic ${Buffer.from("rotate:").toString("base64")}`;

  assert.equal(authorizeProxyRequest(emptyPassword, registry), undefined);
  assert.equal(authorizeProxyRequest(emptyPassword, authentication), undefined);
});

test("proxy token grace periods must be bounded safe integers", () => {
  const registry = new ProxyTokenRegistry({ initialTokens: ["proxy-secret"] });
  const id = registry.snapshot()[0]?.id as string;

  assert.throws(() => registry.revoke(id, Number.MAX_SAFE_INTEGER + 1), /graceMs/);
  assert.throws(() => registry.revoke(id, 1e308), /graceMs/);
});
