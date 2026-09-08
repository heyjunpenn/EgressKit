export interface ConnectionMetric {
  latencyMs?: number;
  result: "failure" | "success";
}

export interface MetricsSnapshot {
  activeSessions: number;
  nodeStatuses: Readonly<Record<string, number>>;
  operationStatuses: Readonly<Record<string, number>>;
}

const LATENCY_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 5_000, 10_000] as const;

export class EgressdMetrics {
  #connectionFailures = 0;
  #connectionSuccesses = 0;
  #fallbacks = 0;
  #latencyBucketCounts = LATENCY_BUCKETS_MS.map(() => 0);
  #latencyCount = 0;
  #latencySum = 0;

  recordConnection(connection: ConnectionMetric): void {
    if (connection.result === "success") {
      this.#connectionSuccesses += 1;
      if (connection.latencyMs !== undefined && Number.isFinite(connection.latencyMs)) {
        const latency = Math.max(0, connection.latencyMs);
        this.#latencyCount += 1;
        this.#latencySum += latency;
        for (const [index, boundary] of LATENCY_BUCKETS_MS.entries()) {
          if (latency <= boundary) {
            this.#latencyBucketCounts[index] = (this.#latencyBucketCounts[index] ?? 0) + 1;
          }
        }
      }
      return;
    }
    this.#connectionFailures += 1;
  }

  recordFallback(): void {
    this.#fallbacks += 1;
  }

  render(snapshot: MetricsSnapshot): string {
    const lines = [
      "# HELP egresskit_connections_total Completed upstream connection attempts.",
      "# TYPE egresskit_connections_total counter",
      `egresskit_connections_total{result="success"} ${this.#connectionSuccesses}`,
      `egresskit_connections_total{result="failure"} ${this.#connectionFailures}`,
      "# HELP egresskit_connection_failures_total Failed upstream connection attempts.",
      "# TYPE egresskit_connection_failures_total counter",
      `egresskit_connection_failures_total ${this.#connectionFailures}`,
      "# HELP egresskit_fallbacks_total Upstream fallback attempts.",
      "# TYPE egresskit_fallbacks_total counter",
      `egresskit_fallbacks_total ${this.#fallbacks}`,
      "# HELP egresskit_nodes Current nodes grouped by bounded health status.",
      "# TYPE egresskit_nodes gauge",
      ...renderBoundedGauge("egresskit_nodes", "status", snapshot.nodeStatuses),
      "# HELP egresskit_operations Current subscription operations grouped by bounded status.",
      "# TYPE egresskit_operations gauge",
      ...renderBoundedGauge("egresskit_operations", "status", snapshot.operationStatuses),
      "# HELP egresskit_active_sessions Current persisted session bindings.",
      "# TYPE egresskit_active_sessions gauge",
      `egresskit_active_sessions ${snapshot.activeSessions}`,
      "# HELP egresskit_connection_latency_ms Upstream connection latency in milliseconds.",
      "# TYPE egresskit_connection_latency_ms histogram",
    ];
    for (const [index, boundary] of LATENCY_BUCKETS_MS.entries()) {
      lines.push(
        `egresskit_connection_latency_ms_bucket{le="${boundary}"} ${this.#latencyBucketCounts[index] ?? 0}`,
      );
    }
    lines.push(
      `egresskit_connection_latency_ms_bucket{le="+Inf"} ${this.#latencyCount}`,
      `egresskit_connection_latency_ms_sum ${this.#latencySum}`,
      `egresskit_connection_latency_ms_count ${this.#latencyCount}`,
      "",
    );
    return lines.join("\n");
  }
}

export function subscriptionLogOrigin(value: string): string {
  return new URL(value).origin;
}

function renderBoundedGauge(
  metric: string,
  label: string,
  values: Readonly<Record<string, number>>,
): string[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => `${metric}{${label}="${value}"} ${count}`);
}
