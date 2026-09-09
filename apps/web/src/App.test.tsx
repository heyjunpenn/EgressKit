// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { gatewayAddress } from "./pages";

const snapshot = {
  generatedAt: "2026-09-09T09:00:00.000Z",
  gateway: { host: "127.0.0.1", port: 8787, ready: true },
  metrics: {
    activeSessions: 2,
    failedConnections: 1,
    healthyNodes: 1,
    successConnections: 18,
    totalNodes: 1,
  },
  nodes: [
    {
      activeConnections: 2,
      alias: "tokyo-a",
      enabled: true,
      id: "asia:tokyo",
      latencyMs: 42,
      status: "healthy",
      successRate: 0.98,
    },
  ],
  nodeStatusCounts: { healthy: 1 },
  operationCounts: { failed: 1, succeeded: 3 },
  operations: [
    {
      id: "op-1",
      status: "succeeded",
      subscriptionId: "asia",
      updatedAt: "2026-09-09T08:59:00.000Z",
    },
  ],
  sessions: [
    {
      activeConnections: 2,
      createdAt: 1_757_408_400_000,
      id: "f3b9…c8fe",
      lastUsedAt: 1_757_408_990_000,
      mode: "sticky",
      nodeId: "asia:tokyo",
    },
  ],
  subscriptions: [
    {
      id: "asia",
      kind: "remote",
      locator: "https://provider.example/…",
      nodeCount: 1,
      status: "healthy",
    },
  ],
};

describe("console router", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("redirects a protected deep link to token connection", () => {
    render(
      <MemoryRouter initialEntries={["/app/subscriptions"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "连接控制台" })).toBeTruthy();
    expect(screen.queryByText(/Administrator|Admin 已认证|退出登录/)).toBeNull();
  });

  it.each([
    ["/app", "运行概览"],
    ["/app/subscriptions", "订阅管理"],
    ["/app/proxies", "代理管理"],
    ["/app/sessions", "活跃会话"],
    ["/app/playground", "快捷操作 Playground"],
    ["/app/docs", "使用文档"],
  ])("renders authenticated route %s", async (path, heading) => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(snapshot), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  });

  it("redirects an unknown route to the overview", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(snapshot), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/app/unknown"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "运行概览" })).toBeTruthy();
  });

  it("moves focus into the mobile navigation and closes it with Escape", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(snapshot), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/app"]}>
        <App />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("button", { name: "打开导航" }));
    expect(screen.getByRole("dialog", { name: "移动导航" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭导航" })),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "移动导航" })).toBeNull();
  });

  it("opens the requested route after validating the token", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/console/snapshot") {
        return new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/app/subscriptions"]}>
        <App />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("Admin Token"), "admin-secret");
    await user.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "订阅管理" })).toBeTruthy());
    expect(screen.getByText("asia", { exact: false })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "主要导航" })).toBeTruthy();
    expect(sessionStorage.getItem("egresskit-admin-token")).toBe("admin-secret");
  });

  it("clears an expired token and returns to the connection screen", async () => {
    sessionStorage.setItem("egresskit-admin-token", "expired");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    render(
      <MemoryRouter initialEntries={["/app/proxies"]}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "连接控制台" })).toBeTruthy());
    expect(sessionStorage.getItem("egresskit-admin-token")).toBeNull();
  });

  it("clears an expired token when a mutation returns 401", async () => {
    sessionStorage.setItem("egresskit-admin-token", "expired");
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/app/proxies"]}>
        <App />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole("switch", { name: "停用 tokyo-a" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "连接控制台" })).toBeTruthy());
    expect(sessionStorage.getItem("egresskit-admin-token")).toBeNull();
  });

  it("keeps Playground proxy credentials ephemeral and generates every routing mode", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(snapshot), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/app/playground"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "快捷操作 Playground" });
    await user.type(screen.getByLabelText("Proxy Token"), "do-not-persist");
    expect(screen.getByText(/rotate:\$PROXY_TOKEN/)).toBeTruthy();
    expect(Object.values(sessionStorage)).not.toContain("do-not-persist");

    await user.selectOptions(screen.getByLabelText("代理模式"), "strict");
    expect(screen.getByText(/strict\.session-demo:\$PROXY_TOKEN/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("代理模式"), "node");
    expect(screen.getByText(/node\.tokyo-a:\$PROXY_TOKEN/)).toBeTruthy();

    const target = screen.getByLabelText("目标 URL");
    await user.clear(target);
    await user.type(target, "https://example.com; touch /tmp/pwned");
    expect(screen.getByText(/'https:\/\/example\.com; touch \/tmp\/pwned'/)).toBeTruthy();
  });

  it("uses the browser hostname when the daemon listens on all interfaces", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...snapshot, gateway: { ...snapshot.gateway, host: "0.0.0.0" } }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/app/playground"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/http:\/\/localhost:8787/)).toBeTruthy();
  });

  it("renders a copyable Docker example without diff markers", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(snapshot), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/app/docs"]}>
        <App />
      </MemoryRouter>,
    );

    const command = await screen.findByText(/docker run --rm/);
    expect(command.textContent).not.toContain("\n+");
  });

  it("normalizes an already bracketed IPv6 gateway host", () => {
    expect(gatewayAddress("[::1]", 8787)).toBe("[::1]:8787");
  });
});
