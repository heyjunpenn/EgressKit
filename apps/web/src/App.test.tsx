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
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
        root = null;
        rootMargin = "0px";
        thresholds = [0];
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: target.getBoundingClientRect(),
                borderBoxSize: [{ blockSize: 384, inlineSize: 1024 }],
                contentBoxSize: [{ blockSize: 384, inlineSize: 1024 }],
                devicePixelContentBoxSize: [{ blockSize: 384, inlineSize: 1024 }],
              } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(384);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1024);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 384,
      height: 384,
      left: 0,
      right: 1024,
      top: 0,
      width: 1024,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    ["/app/playground", "快速操作"],
    ["/app/docs", "使用文档"],
  ])("renders authenticated route %s", async (path, label) => {
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

    expect(await screen.findByRole("main", { name: `${label}面板` })).toBeTruthy();
    expect(screen.getByRole("link", { name: "EgressKit" })).toBeTruthy();
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

    expect(await screen.findByRole("main", { name: "运行概览面板" })).toBeTruthy();
  });

  it("renders the branded header and language placeholder", async () => {
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
      <MemoryRouter initialEntries={["/app"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("main", { name: "运行概览面板" });
    const navigation = screen.getByRole("navigation", { name: "主要导航" });
    expect(navigation.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(screen.getByRole("button", { name: "运行概览" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.queryByRole("heading", { name: "订阅管理" })).toBeNull();
    expect(screen.getByRole("link", { name: "EgressKit" })).toBeTruthy();
    expect(screen.getByLabelText("界面语言 / Language")).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用文档" })).toBeTruthy();
  });

  it("offers Chinese and English without translating or refetching", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/app"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("main", { name: "运行概览面板" });
    await user.click(screen.getByLabelText("界面语言 / Language"));
    expect(screen.getByRole("option", { name: "中文" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "English" }));

    expect(screen.getByText("代理入口")).toBeTruthy();
    expect(screen.getByLabelText("界面语言 / Language").textContent).toContain("English");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps a legacy hash to its canonical route and mounts one panel", async () => {
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
      <MemoryRouter initialEntries={["/app#proxies"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("main", { name: "代理管理面板" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "运行概览" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "订阅管理" })).toBeNull();
    expect(screen.getByRole("button", { name: "代理管理" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("switches routes without mounting the other management panels", async () => {
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

    await screen.findByRole("main", { name: "运行概览面板" });
    await user.click(screen.getByRole("button", { name: "活跃会话" }));

    expect(await screen.findByRole("main", { name: "活跃会话面板" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "运行概览" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "代理管理" })).toBeNull();
    expect(screen.getByRole("button", { name: "活跃会话" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("removes redundant collection headings and counts", async () => {
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
      <MemoryRouter initialEntries={["/app/subscriptions"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("main", { name: "订阅管理面板" });
    expect(screen.queryByText("全部订阅")).toBeNull();
    await user.click(screen.getByRole("button", { name: "代理管理" }));
    await screen.findByRole("main", { name: "代理管理面板" });
    expect(screen.queryByText("节点列表")).toBeNull();
    await user.click(screen.getByRole("button", { name: "活跃会话" }));
    await screen.findByRole("main", { name: "活跃会话面板" });
    expect(screen.queryByText("会话列表")).toBeNull();
    expect(screen.queryByText(/个会话 · .*个绑定/)).toBeNull();
  });

  it("teaches how active sessions appear in an empty state", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...snapshot,
              metrics: { ...snapshot.metrics, activeSessions: 0 },
              sessions: [],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    render(
      <MemoryRouter initialEntries={["/app/sessions"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/客户端使用 sticky 或 strict 模式建立连接后/)).toBeTruthy();
  });

  it("deduplicates repeated connection snapshots", async () => {
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

    await screen.findByText("最近 1 次");
    await user.click(screen.getAllByRole("button", { name: "刷新" })[0] as HTMLElement);

    await waitFor(() => expect(screen.getByText("最近 1 次")).toBeTruthy());
    expect(screen.queryByText("最近 2 次")).toBeNull();
  });

  it("explains process-lifetime metrics and localizes machine statuses", async () => {
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
      <MemoryRouter initialEntries={["/app"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("本次运行成功连接")).toBeTruthy();
    expect(screen.getByText("本次运行失败连接")).toBeTruthy();
    expect(screen.getAllByText("健康").length).toBeGreaterThan(0);
    expect(screen.getAllByText("就绪").length).toBeGreaterThan(0);
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

    await waitFor(() => expect(screen.getByRole("main", { name: "订阅管理面板" })).toBeTruthy());
    expect(screen.getAllByText("asia", { exact: false }).length).toBeGreaterThan(0);
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

  it("uses a literal Playground token placeholder and generates every routing mode", async () => {
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

    await screen.findByRole("main", { name: "快速操作面板" });
    expect(screen.queryByText("请在你信任的终端中执行")).toBeNull();
    expect(screen.queryByText("命令已复制")).toBeNull();
    expect(screen.getByText(/rotate:PROXY_TOKEN/)).toBeTruthy();
    expect(screen.queryByText(/\$PROXY_TOKEN/)).toBeNull();

    await user.click(screen.getByLabelText("代理模式"));
    await user.click(screen.getByRole("option", { name: "Strict sticky" }));
    expect(screen.getByText(/strict\.session-demo:PROXY_TOKEN/)).toBeTruthy();
    await user.click(screen.getByLabelText("代理模式"));
    await user.click(screen.getByRole("option", { name: "指定节点" }));
    expect(screen.getByText(/node\.tokyo-a:PROXY_TOKEN/)).toBeTruthy();

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

    expect((await screen.findAllByText(/http:\/\/localhost:8787/)).length).toBeGreaterThan(0);
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
