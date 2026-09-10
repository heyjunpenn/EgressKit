// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { gatewayAddress, gatewayUrl } from "./pages";

const snapshot = {
  exitIps: [{ ip: "203.0.113.24", location: "JP-Tokyo", nodeCount: 1 }],
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
      exitIp: "203.0.113.24",
      exitLocation: "JP-Tokyo",
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
      kind: "refresh",
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
      name: "Provider Asia",
      nodeCount: 1,
      status: "healthy",
    },
  ],
};

const runtimeSettings = {
  healthCheckConcurrency: 4,
  healthCheckIntervalMs: 30_000,
  healthCheckJitterMs: 5_000,
  healthCheckSuccessThreshold: 1,
  healthCheckUrls: ["https://www.gstatic.com/generate_204"],
  host: "0.0.0.0",
  mihomoBinary: "",
  mihomoHttpListener: "",
  minimumSubscriptionNodes: 1,
  port: 8787,
  preconnectAttempts: 3,
  preconnectTimeoutMs: 10_000,
  proxyAuthEnabled: true,
  proxyToken: "old-proxy-token",
  remoteSubscriptionRefreshIntervalMs: 600_000,
  sessionAbsoluteTtlMs: 1_800_000,
  sessionIdleTimeoutMs: 300_000,
  sessionMaximumActiveSessions: 10_000,
  sessionMaximumConcurrentConnections: 50,
  targetReputationEnabled: false,
};

describe("console router", () => {
  beforeEach(() => {
    sessionStorage.clear();
    const localValues = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => localValues.clear(),
      getItem: (key: string) => localValues.get(key) ?? null,
      removeItem: (key: string) => localValues.delete(key),
      setItem: (key: string, value: string) => localValues.set(key, value),
    });
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

  it("presents the connection screen as a responsive product introduction and form", () => {
    render(
      <MemoryRouter initialEntries={["/app/connect"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByRole("region", { name: "EgressKit 简介" })).toBeTruthy();
    expect(screen.getByText("Clash/Vless -> Http Proxy")).toBeTruthy();
    expect(screen.getByRole("img", { name: "EgressKit 代理路由示意图" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "连接表单" })).toBeTruthy();
    expect(screen.getByAltText("EgressKit").className).toContain("h-8");
  });

  it.each([
    ["/app", "运行概览"],
    ["/app/subscriptions", "订阅管理"],
    ["/app/proxies", "代理管理"],
    ["/app/sessions", "活跃会话"],
    ["/app/playground", "快速操作"],
    ["/app/settings", "设置"],
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

  it("shows the exit IP check time without a vertical table scroller", async () => {
    localStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...snapshot,
              nodes: [{ ...snapshot.nodes[0], exitVerifiedAt: 1_757_408_400_000 }],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    render(
      <MemoryRouter initialEntries={["/app/proxies"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("columnheader", { name: "检查时间" });
    expect(screen.getByText(new Date(1_757_408_400_000).toLocaleString())).toBeTruthy();
    expect(screen.getByRole("table").parentElement?.className).not.toContain("overflow-auto");
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

  it("only edits the proxy token in the gateway section and resets it to a random value", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/settings") {
        const settings = init?.method === "PUT" ? JSON.parse(String(init.body)) : runtimeSettings;
        return new Response(JSON.stringify({ restartRequiredFields: [], settings }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(snapshot), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/app/settings"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText("Proxy Token")).toBeTruthy();
    expect(screen.queryByLabelText("监听地址")).toBeNull();
    expect(screen.queryByLabelText("监听端口")).toBeNull();
    expect(screen.queryByLabelText("Mihomo 路径")).toBeNull();
    expect(screen.getByLabelText("探活间隔（秒）").getAttribute("value")).toBe("30");
    expect(screen.getByLabelText("订阅刷新间隔（秒）").getAttribute("value")).toBe("600");

    await user.click(screen.getByRole("button", { name: "随机重置 Proxy Token" }));
    await waitFor(() => {
      const put = request.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put).toBeTruthy();
      const body = JSON.parse(String(put?.[1]?.body));
      expect(body.proxyToken).not.toBe("old-proxy-token");
      expect(body.proxyToken).toMatch(/^ek_[a-f0-9]{48}$/);
      expect(body.healthCheckIntervalMs).toBe(30_000);
    });
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
    const docsLink = screen.getByRole("link", { name: "使用文档" });
    expect(docsLink.getAttribute("href")).toBe("https://github.com/heyjunpenn/EgressKit#readme");
    expect(docsLink.getAttribute("target")).toBe("_blank");
    expect(docsLink.getAttribute("rel")).toBe("noopener noreferrer");
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
    const languageTrigger = screen.getByLabelText("界面语言 / Language");
    await user.click(languageTrigger);
    expect(languageTrigger.style.borderBottomLeftRadius).not.toBe("0px");
    expect(languageTrigger.style.borderBottomRightRadius).not.toBe("0px");
    expect(screen.getByRole("option", { name: "中文" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "English" }));

    expect(screen.getByText("代理入口")).toBeTruthy();
    expect(screen.getByLabelText("界面语言 / Language")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("logs out from the header and returns to the connection screen", async () => {
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
    await user.click(screen.getByRole("button", { name: "退出登录" }));

    expect(sessionStorage.getItem("egresskit-admin-token")).toBeNull();
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "连接控制台" })).toBeTruthy();
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
    expect(screen.getByText("出口 IP")).toBeTruthy();
    expect(screen.getByText("203.0.113.24")).toBeTruthy();
    expect(screen.getByText("JP-Tokyo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "验证 tokyo-a 出口 IP" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "运行概览" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "订阅管理" })).toBeNull();
    expect(screen.getByRole("button", { name: "代理管理" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("filters proxy nodes by exit IP", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    const nodes = [
      snapshot.nodes[0],
      {
        ...snapshot.nodes[0],
        alias: "osaka-b",
        exitIp: "198.51.100.8",
        exitLocation: "JP-Osaka",
        id: "asia:osaka",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...snapshot,
              exitIps: [
                { ip: "198.51.100.8", location: "JP-Osaka", nodeCount: 1 },
                { ip: "203.0.113.24", location: "JP-Tokyo", nodeCount: 1 },
              ],
              nodes,
            }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/app/proxies"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText("osaka-b");
    await user.click(screen.getByLabelText("按出口 IP 筛选节点"));
    const exitIpList = screen.getByRole("listbox");
    expect(exitIpList.firstElementChild?.className).toContain("max-h-[50vh]");
    expect(exitIpList.firstElementChild?.className).toContain("overflow-y-auto");
    await user.click(screen.getByRole("option", { name: /198\.51\.100\.8.*JP-Osaka/ }));
    expect(screen.getByText("osaka-b")).toBeTruthy();
    expect(screen.queryByText("tokyo-a")).toBeNull();
  });

  it("bulk verifies exit IPs with loading and toast feedback", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    let finish: ((response: Response) => void) | undefined;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/nodes/verify-exits" && init?.method === "POST") {
        return await new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return new Response(JSON.stringify(snapshot), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/app/proxies"]}>
        <App />
      </MemoryRouter>,
    );

    const button = await screen.findByRole("button", { name: "全部出口IP（1）" });
    await user.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    finish?.(
      new Response(JSON.stringify({ failed: 0, succeeded: 1, total: 1 }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await screen.findByText("出口 IP 验证完成：1/1")).toBeTruthy();
    expect(button.getAttribute("aria-busy")).toBe("false");
  });

  it("reports a failed exit-IP operation through a toast and clears loading", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/nodes/verify-exits"
          ? new Response(JSON.stringify({ error: "verification unavailable" }), {
              headers: { "content-type": "application/json" },
              status: 503,
            })
          : new Response(JSON.stringify(snapshot), {
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/app/proxies"]}>
        <App />
      </MemoryRouter>,
    );

    const button = await screen.findByRole("button", { name: "全部出口IP（1）" });
    await user.click(button);

    expect(await screen.findByText("verification unavailable")).toBeTruthy();
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByText("verification unavailable", { selector: "main *" })).toBeNull();
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

  it("confirms subscription deletion in the styled dialog", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/subscriptions/asia" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(snapshot), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/app/subscriptions"]}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole("main", { name: "订阅管理面板" });
    await user.click(screen.getByRole("button", { name: "删除 asia" }));
    expect(screen.getByRole("dialog", { name: "删除订阅" })).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith(
      "/subscriptions/asia",
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "/subscriptions/asia",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
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

  it("paginates management tables with 10, 20, or 30 rows per page", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    const sessions = Array.from({ length: 31 }, (_, index) => ({
      ...snapshot.sessions[0],
      id: `session-${index + 1}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...snapshot, sessions }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/app/sessions"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("1–10 / 31")).toBeTruthy();
    await user.click(screen.getByLabelText("每页条数"));
    await user.click(screen.getByRole("option", { name: "20" }));
    expect(screen.getByText("1–20 / 31")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("21–31 / 31")).toBeTruthy();
  });

  it("previews the first ten proxies and exit IPs with links to proxy management", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      ...snapshot.nodes[0],
      alias: `proxy-${index + 1}`,
      exitIp: `203.0.113.${index + 1}`,
      id: `proxy:${index + 1}`,
    }));
    const exitIps = Array.from({ length: 12 }, (_, index) => ({
      ip: `203.0.113.${index + 1}`,
      location: `C${index + 1}-City${index + 1}`,
      nodeCount: 1,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...snapshot, exitIps, nodes }), {
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

    await screen.findByText("代理预览");
    expect(screen.getByText("出口 IP 预览")).toBeTruthy();
    expect(screen.getByText("proxy-10")).toBeTruthy();
    expect(screen.queryByText("proxy-11")).toBeNull();
    expect(screen.getAllByText("203.0.113.10")).toHaveLength(2);
    expect(screen.queryByText("203.0.113.11")).toBeNull();
    expect(screen.getAllByRole("link", { name: "查看全部" })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "查看全部" })) {
      expect(link.getAttribute("href")).toBe("/app/proxies");
    }
    await user.click(screen.getAllByRole("button", { name: "刷新" })[0] as HTMLElement);

    await waitFor(() => expect(screen.getByText("proxy-1")).toBeTruthy());
    expect(screen.queryByText("连接采样")).toBeNull();
    expect(screen.queryByText("最近操作")).toBeNull();
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
    expect(screen.getByText("可用节点")).toBeTruthy();
    expect(screen.getByText("订阅数")).toBeTruthy();
    expect(screen.getByText("代理预览")).toBeTruthy();
    expect(screen.getByText("出口 IP 预览")).toBeTruthy();
    expect(screen.getAllByText("就绪").length).toBeGreaterThan(0);
    expect(screen.queryByText("同步订阅")).toBeNull();
    expect(screen.queryByText(snapshot.operations[0].subscriptionId)).toBeNull();
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
    expect(screen.getByText("Provider Asia")).toBeTruthy();
    expect(screen.queryByText("asia")).toBeNull();
    expect(screen.getByRole("navigation", { name: "主要导航" })).toBeTruthy();
    expect(localStorage.getItem("egresskit-admin-token")).toBe("admin-secret");
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
    expect(localStorage.getItem("egresskit-admin-token")).toBeNull();
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
    expect(localStorage.getItem("egresskit-admin-token")).toBeNull();
  });

  it("uses the real proxy token, generates routing modes, and executes a request", async () => {
    sessionStorage.setItem("egresskit-admin-token", "admin-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        const body = path.includes("/playground/config")
          ? { proxyToken: "real-proxy-token", proxyTokenAvailable: true }
          : path.includes("/playground/execute")
            ? { body: '{"origin":"203.0.113.1"}', durationMs: 42, headers: {}, status: 200 }
            : snapshot;
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      }),
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
    expect(await screen.findByText(/rotate:real-proxy-token/)).toBeTruthy();

    await user.click(screen.getByLabelText("代理模式"));
    await user.click(screen.getByRole("option", { name: "Strict sticky" }));
    expect(screen.getByText(/strict\.session-demo:real-proxy-token/)).toBeTruthy();
    await user.click(screen.getByLabelText("代理模式"));
    await user.click(screen.getByRole("option", { name: "指定节点" }));
    expect(screen.getByText(/node\.tokyo-a:real-proxy-token/)).toBeTruthy();

    const target = screen.getByLabelText("目标 URL");
    await user.clear(target);
    await user.type(target, "https://example.com; touch /tmp/pwned");
    expect(screen.getByText(/'https:\/\/example\.com; touch \/tmp\/pwned'/)).toBeTruthy();
    await user.clear(target);
    await user.type(target, "https://example.com");
    await user.click(screen.getByRole("button", { name: "发起请求" }));
    expect(await screen.findByText(/203\.0\.113\.1/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "请求日志" })).toBeTruthy();
    const requestLog = screen.getByRole("button", { name: /https:\/\/example\.com.*成功/ });
    expect(requestLog.textContent).toContain("HTTP 200");
    await user.click(screen.getByRole("button", { name: "检查出口 IP" }));
    expect((target as HTMLInputElement).value).toBe("https://ipinfo.io/json");
    await user.click(requestLog);
    expect((target as HTMLInputElement).value).toBe("https://example.com");
    expect(screen.getByText(/203\.0\.113\.1/)).toBeTruthy();
  });

  it("uses the browser origin when the daemon listens on all interfaces", async () => {
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

    expect(
      (
        await screen.findAllByText(
          (_, element) => element?.textContent?.includes(window.location.origin) ?? false,
        )
      ).length,
    ).toBeGreaterThan(0);
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

  it("uses the externally visible origin for a wildcard Docker listener", () => {
    expect(gatewayUrl("0.0.0.0", 8787, "https://proxy.example.com")).toBe(
      "https://proxy.example.com",
    );
    expect(gatewayUrl("[::1]", 8787, "https://proxy.example.com")).toBe("http://[::1]:8787");
  });
});
