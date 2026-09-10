export interface MetricsSummary {
  activeSessions: number;
  failedConnections: number;
  healthyNodes: number;
  successConnections: number;
  totalNodes: number;
}

export function parseMetrics(source: string): MetricsSummary {
  const values = [...source.matchAll(/^([^#\s][^\s]*)\s+([\d.]+)$/gm)].map(
    (match) => [match[1] as string, Number(match[2])] as const,
  );
  const read = (name: string) => values.find(([metric]) => metric === name)?.[1] ?? 0;
  const nodeValues = values.filter(([name]) => name.startsWith("egresskit_nodes{"));
  return {
    activeSessions: read("egresskit_active_sessions"),
    failedConnections: read('egresskit_connections_total{result="failure"}'),
    healthyNodes: read('egresskit_nodes{status="available"}'),
    successConnections: read('egresskit_connections_total{result="success"}'),
    totalNodes: nodeValues.reduce((total, [, value]) => total + value, 0),
  };
}
