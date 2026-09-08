import assert from "node:assert/strict";
import { test } from "node:test";

import { EgressdMetrics, subscriptionLogOrigin } from "./observability.js";

test("Prometheus metrics cover bounded operational signals without secret labels", () => {
  const metrics = new EgressdMetrics();
  metrics.recordConnection({ result: "failure" });
  metrics.recordFallback();
  metrics.recordConnection({ latencyMs: 42, result: "success" });

  const output = metrics.render({
    activeSessions: 7,
    nodeStatuses: { cooldown: 1, healthy: 2 },
    operationStatuses: { failed: 1, succeeded: 3 },
  });

  for (const name of [
    "egresskit_connections_total",
    "egresskit_connection_failures_total",
    "egresskit_fallbacks_total",
    "egresskit_nodes",
    "egresskit_operations",
    "egresskit_active_sessions",
    "egresskit_connection_latency_ms",
  ]) {
    assert.match(output, new RegExp(name));
  }
  assert.match(output, /egresskit_connections_total\{result="success"\} 1/);
  assert.match(output, /egresskit_connections_total\{result="failure"\} 1/);
  assert.match(output, /egresskit_nodes\{status="healthy"\} 2/);
  assert.match(output, /egresskit_operations\{status="succeeded"\} 3/);
  assert.doesNotMatch(
    output,
    /session_key|target\.example|provider\.example|subscription_url|token|cookie|authorization|secret/i,
  );
});

test("subscription log URLs retain only scheme, host, and explicit port", () => {
  assert.equal(
    subscriptionLogOrigin(
      "https://user:password@provider.example:8443/private/path?token=secret#fragment",
    ),
    "https://provider.example:8443",
  );
});
