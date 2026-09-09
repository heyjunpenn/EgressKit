import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api";

describe("authenticated API client", () => {
  it("adds the admin bearer token to every request", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const client = createApiClient("admin-secret", request);

    await client.get<{ ok: boolean }>("/metrics");

    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer admin-secret");
  });

  it("turns an unauthorized response into an authentication error", async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient(
      "expired",
      async () => new Response(null, { status: 401 }),
      onUnauthorized,
    );

    await expect(client.get("/metrics")).rejects.toEqual(expect.objectContaining({ status: 401 }));
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("sends local subscription YAML without JSON encoding", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ nodes: [] })));
    const client = createApiClient("admin-secret", request);

    await client.sendText("/subscriptions/local", "proxies:\n  - name: tokyo");

    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe("proxies:\n  - name: tokyo");
    expect(new Headers(init.headers).get("content-type")).toBe("text/yaml; charset=utf-8");
  });

  it("keeps a safe server error for actionable conflict feedback", async () => {
    const client = createApiClient(
      "admin-secret",
      async () =>
        new Response(JSON.stringify({ error: "node alias conflicts with an existing selector" }), {
          headers: { "content-type": "application/json" },
          status: 409,
        }),
    );

    await expect(client.send("/nodes/id/alias", "PUT", { alias: "taken" })).rejects.toThrow(
      "node alias conflicts with an existing selector",
    );
  });
});
