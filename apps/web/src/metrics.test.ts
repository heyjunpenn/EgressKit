import { describe, expect, it } from "vitest";
import { parseMetrics } from "./metrics";

describe("parseMetrics", () => {
  it("summarizes node and session metrics from the daemon response", () => {
    expect(
      parseMetrics(`
egresskit_active_sessions 7
egresskit_nodes{status="healthy"} 12
egresskit_nodes{status="cooldown"} 2
egresskit_connections_total{result="success"} 341
egresskit_connections_total{result="failure"} 9
`),
    ).toEqual({
      activeSessions: 7,
      failedConnections: 9,
      healthyNodes: 12,
      successConnections: 341,
      totalNodes: 14,
    });
  });

  it("returns zeroes for an empty metrics response", () => {
    expect(parseMetrics("")).toEqual({
      activeSessions: 0,
      failedConnections: 0,
      healthyNodes: 0,
      successConnections: 0,
      totalNodes: 0,
    });
  });
});
