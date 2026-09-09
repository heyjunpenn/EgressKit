export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  send<T>(path: string, method: "DELETE" | "POST" | "PUT", body?: unknown): Promise<T>;
  sendText<T>(path: string, body: string): Promise<T>;
}

export interface ConsoleSnapshot {
  generatedAt: string;
  gateway: { host: string; port: number; ready: boolean };
  metrics: {
    activeSessions: number;
    failedConnections: number;
    healthyNodes: number;
    successConnections: number;
    totalNodes: number;
  };
  nodes: Array<{
    activeConnections: number;
    alias?: string;
    enabled: boolean;
    id: string;
    latencyMs: number;
    status: string;
    successRate: number;
  }>;
  nodeStatusCounts: Record<string, number>;
  operationCounts: Record<string, number>;
  operations: Array<{
    id: string;
    status: string;
    subscriptionId: string;
    updatedAt: string;
  }>;
  sessions: Array<{
    activeConnections: number;
    createdAt: number;
    id: string;
    lastUsedAt: number;
    mode: "sticky" | "strict";
    nodeId: string;
  }>;
  subscriptions: Array<{
    id: string;
    kind: "local" | "remote";
    locator: string;
    nodeCount: number;
    revisionId?: number;
    status: string;
    updatedAt?: string;
  }>;
}

export interface OperationResponse {
  failure?: { reason: string; stage: string };
  operationId: string;
  revisionId?: number;
  status: string;
  subscriptionId: string;
}

export const consoleSnapshotPath = "/console/snapshot";

export function createApiClient(
  adminToken: string,
  request: typeof fetch = fetch,
  onUnauthorized?: () => void,
): ApiClient {
  const execute = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await request(path, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${adminToken}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      if (response.status === 401) {
        onUnauthorized?.();
      }
      let serverMessage: string | undefined;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") serverMessage = body.error;
      } catch {
        // Non-JSON failures use the stable status fallback below.
      }
      const message =
        response.status === 401
          ? "Admin token 无效或已失效"
          : (serverMessage ?? `请求失败 (${response.status})`);
      throw new ApiError(message, response.status);
    }
    const contentType = response.headers.get("content-type") ?? "";
    return (
      contentType.includes("application/json") ? await response.json() : await response.text()
    ) as T;
  };

  return {
    get: <T>(path: string) => execute<T>(path),
    send: <T>(path: string, method: "DELETE" | "POST" | "PUT", body?: unknown) =>
      execute<T>(path, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        method,
      }),
    sendText: <T>(path: string, body: string) =>
      execute<T>(path, {
        body,
        headers: { "content-type": "text/yaml; charset=utf-8" },
        method: "POST",
      }),
  };
}
