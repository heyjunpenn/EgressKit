import {
  ArrowClockwise,
  CheckCircle,
  Clipboard,
  CloudArrowDown,
  Code,
  Copy,
  LinkSimple,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Pulse,
  ShieldCheck,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useConsole } from "./App";
import type { ApiClient, OperationResponse } from "./api";

function Header({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#ff5538]">
          EgressKit Console
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-.05em] sm:text-5xl">{title}</h1>
        <p className="mt-3 text-sm text-[#66706a]">{description}</p>
      </div>
      {action}
    </header>
  );
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-black/6 bg-white p-5 sm:p-6 ${className}`}>
      {children}
    </section>
  );
}

function Status({ value }: { value: string }) {
  const good = value === "healthy" || value === "ready" || value === "succeeded";
  const warning = value === "degraded" || value === "warming" || value === "pending";
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${good ? "bg-emerald-50 text-emerald-700" : warning ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}
    >
      {value}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-[#f5f6f4] px-5 py-12 text-center text-sm text-[#7c857f]">
      {children}
    </div>
  );
}

export function OverviewPage() {
  const { connectionSamples, refresh, snapshot } = useConsole();
  const { metrics } = snapshot;
  const gateway = `http://${gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}`;
  const [copied, setCopied] = useState(false);
  const copyGateway = async () => {
    await navigator.clipboard?.writeText(gateway);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };
  const stats = [
    ["健康节点", `${metrics.healthyNodes} / ${metrics.totalNodes}`, Pulse],
    ["活跃会话", String(metrics.activeSessions), UsersThree],
    ["成功连接", String(metrics.successConnections), CheckCircle],
    ["失败连接", String(metrics.failedConnections), WarningCircle],
  ] as const;
  return (
    <>
      <Header
        title="运行概览"
        description="一个入口，管理所有代理出口。"
        action={
          <button className="btn-primary" type="button" onClick={() => void refresh()}>
            <ArrowClockwise size={18} />
            刷新
          </button>
        }
      />
      <Card className="mb-5 overflow-hidden bg-[#fff1ed]">
        <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-end">
          <div>
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ${snapshot.gateway.ready ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}
            >
              <i
                className={`size-2 rounded-full ${snapshot.gateway.ready ? "bg-emerald-400" : "bg-amber-300"}`}
              />
              {snapshot.gateway.ready ? "Gateway ready" : "Gateway not ready"}
            </span>
            <h2 className="mt-7 max-w-xl text-3xl font-medium leading-tight tracking-[-.04em] sm:text-5xl">
              稳定出口，从一个简洁入口开始。
            </h2>
          </div>
          <button
            className="flex items-center gap-3 rounded-xl border border-black/8 bg-white px-4 py-3 text-left"
            type="button"
            onClick={() => void copyGateway()}
          >
            <span>
              <small className="block text-[#7c857f]">代理入口</small>
              <code className="text-sm">{gateway}</code>
            </span>
            {copied ? <CheckCircle size={18} /> : <Copy size={18} />}
          </button>
          {copied ? (
            <span className="sr-only" role="status">
              代理入口已复制
            </span>
          ) : null}
        </div>
      </Card>
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value, Icon]) => (
          <Card key={label}>
            <Icon className="text-[#ff5538]" size={22} />
            <p className="mt-6 text-sm text-[#66706a]">{label}</p>
            <strong className="mt-1 block text-3xl tracking-[-.04em]">{value}</strong>
          </Card>
        ))}
      </div>
      <Card className="mb-5">
        <h2 className="text-lg font-semibold">节点生命周期</h2>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {["healthy", "degraded", "cooldown", "draining", "disabled"].map((status) => (
            <div className="rounded-xl bg-[#f5f6f4] p-4" key={status}>
              <Status value={status} />
              <strong className="mt-3 block text-2xl">
                {snapshot.nodeStatusCounts[status] ?? 0}
              </strong>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">连接趋势</h2>
            <span className="text-xs text-[#7c857f]">当前浏览器会话</span>
          </div>
          <div
            className="mt-8 flex h-40 items-end gap-2"
            aria-label="当前浏览器会话连接趋势"
            role="img"
          >
            {connectionSamples.map((sample) => (
              <div
                key={sample.at}
                className="min-h-2 flex-1 rounded-t-lg bg-[#ff5538] opacity-85"
                title={`连接总数 ${sample.value}`}
                style={{
                  height: `${Math.max(8, (sample.value / Math.max(...connectionSamples.map((item) => item.value), 1)) * 100)}%`,
                }}
              />
            ))}
          </div>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold">运行摘要</h2>
          <dl className="mt-6 space-y-4 text-sm">
            {snapshot.operations.map((operation) => (
              <div className="border-b border-black/6 pb-3" key={operation.id}>
                <div className="flex items-center justify-between">
                  <dt className="font-medium">{operation.subscriptionId}</dt>
                  <dd>
                    <Status value={operation.status} />
                  </dd>
                </div>
                <p className="mt-1 text-xs text-[#7c857f]">
                  {new Date(operation.updatedAt).toLocaleString()}
                </p>
              </div>
            ))}
            {snapshot.operations.length === 0 ? (
              <p className="text-sm text-[#7c857f]">暂无控制面操作</p>
            ) : null}
            <div className="flex items-center justify-between">
              <dt className="text-[#66706a]">更新时间</dt>
              <dd className="font-medium">{new Date(snapshot.generatedAt).toLocaleTimeString()}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}

export function SubscriptionsPage() {
  const { api, refresh, snapshot } = useConsole();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"local" | "remote">("remote");
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [notice, setNotice] = useState("");
  const [retryAction, setRetryAction] = useState<() => void>();
  const watchOperation = (operation: OperationResponse, retry: () => void) => {
    setRetryAction(undefined);
    void observeOperation(api, operation.operationId, setNotice, refresh).then((succeeded) => {
      if (!succeeded) setRetryAction(() => retry);
    });
  };
  const visible = snapshot.subscriptions.filter(
    (item) =>
      (sourceFilter === "all" || item.kind === sourceFilter) &&
      (statusFilter === "all" || item.status === statusFilter) &&
      `${item.id} ${item.locator}`.toLowerCase().includes(query.toLowerCase()),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice("");
    try {
      const operation =
        kind === "remote"
          ? await api.send<OperationResponse>("/subscriptions/remote", "POST", { url: value })
          : await api.sendText<{ nodes: unknown[] }>("/subscriptions/local", value);
      setNotice(
        "operationId" in operation
          ? `刷新任务 ${operation.operationId} 已进入队列`
          : "本地订阅已应用",
      );
      setValue("");
      setAdding(false);
      await refresh();
      if ("operationId" in operation) {
        watchOperation(operation, () => void refreshSubscription(operation.subscriptionId));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "添加失败");
    }
  };
  const refreshSubscription = async (id: string) => {
    try {
      const operation = await api.send<OperationResponse>(
        `/subscriptions/${encodeURIComponent(id)}/refresh`,
        "POST",
      );
      setNotice(`刷新任务 ${operation.operationId} 已进入队列`);
      await refresh();
      watchOperation(operation, () => void refreshSubscription(id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "刷新失败，请重试");
      setRetryAction(() => () => void refreshSubscription(id));
    }
  };
  const forceRevision = async (revisionId: number) => {
    if (!window.confirm("强制应用可疑 revision 会显著改变节点池，确定继续吗？")) return;
    try {
      const operation = await api.send<OperationResponse>(`/revisions/${revisionId}/force`, "POST");
      setNotice(`强制应用任务 ${operation.operationId} 已进入队列`);
      watchOperation(operation, () => void forceRevision(revisionId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "强制应用失败，请重试");
      setRetryAction(() => () => void forceRevision(revisionId));
    }
  };
  return (
    <>
      <Header
        title="订阅管理"
        description="导入、验证并应用 VLESS 订阅。"
        action={
          <button
            className="btn-primary"
            type="button"
            onClick={() => setAdding((current) => !current)}
          >
            <Plus size={18} />
            添加订阅
          </button>
        }
      />
      {adding ? (
        <Card className="mb-5">
          <form onSubmit={submit}>
            <div className="grid gap-4 md:grid-cols-[180px_1fr_auto]">
              <select
                className="field"
                value={kind}
                onChange={(event) => setKind(event.target.value as "local" | "remote")}
              >
                <option value="remote">远程 URL</option>
                <option value="local">本地 YAML</option>
              </select>
              {kind === "remote" ? (
                <input
                  className="field"
                  aria-label="订阅 URL"
                  type="url"
                  required
                  placeholder="https://provider.example/sub"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              ) : (
                <textarea
                  className="field min-h-28"
                  aria-label="订阅 YAML"
                  required
                  placeholder="粘贴本地 YAML"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
              <button className="btn-primary self-start" type="submit">
                导入
              </button>
            </div>
          </form>
        </Card>
      ) : null}
      {notice ? (
        <div
          className="mb-4 flex items-center justify-between gap-4 rounded-xl bg-[#fff1ed] px-4 py-3 text-sm text-[#b53018]"
          role="status"
        >
          <span>{notice}</span>
          {retryAction ? (
            <button className="font-semibold" type="button" onClick={retryAction}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      <Card>
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">
            全部订阅 <span className="text-[#7c857f]">{snapshot.subscriptions.length}</span>
          </h2>
          <div className="flex flex-wrap gap-2">
            <select
              className="field w-auto"
              aria-label="按来源筛选订阅"
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
            >
              <option value="all">全部来源</option>
              <option value="remote">远程</option>
              <option value="local">本地</option>
            </select>
            <select
              className="field w-auto"
              aria-label="按状态筛选订阅"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">全部状态</option>
              {[
                "pending",
                "saved",
                "downloaded",
                "parsed",
                "validated",
                "accepted",
                "suspicious",
                "ready",
                "healthy",
              ].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <label className="search-field">
              <MagnifyingGlass size={18} />
              <input
                aria-label="搜索订阅"
                placeholder="搜索订阅"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>订阅</th>
                  <th>来源</th>
                  <th>节点</th>
                  <th>状态</th>
                  <th>最近更新</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.id}</strong>
                    </td>
                    <td>{item.kind === "remote" ? item.locator : "本地配置"}</td>
                    <td>{item.nodeCount}</td>
                    <td>
                      <Status value={item.status} />
                    </td>
                    <td>
                      {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "等待首次刷新"}
                    </td>
                    <td className="space-x-2 text-right">
                      {item.status === "suspicious" && item.revisionId ? (
                        <button
                          className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                          type="button"
                          onClick={() => void forceRevision(item.revisionId as number)}
                        >
                          强制应用
                        </button>
                      ) : null}
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`刷新 ${item.id}`}
                        onClick={() => void refreshSubscription(item.id)}
                      >
                        <ArrowClockwise size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {snapshot.subscriptions.length === 0
              ? "还没有订阅，使用右上角“添加订阅”导入第一个来源。"
              : "没有符合搜索条件的订阅。"}
          </Empty>
        )}
      </Card>
    </>
  );
}

export function ProxiesPage() {
  const { api, refresh, snapshot } = useConsole();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<string>();
  const [alias, setAlias] = useState("");
  const [notice, setNotice] = useState("");
  const visible = snapshot.nodes.filter(
    (node) =>
      (filter === "all" || node.status === filter) &&
      `${node.id} ${node.alias ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.send(`/nodes/${encodeURIComponent(id)}/enabled`, "PUT", { enabled });
      setNotice(enabled ? "节点已重新加入健康评估" : "节点已停止接收新分配");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "节点更新失败");
    }
  };
  const saveAlias = async (id: string) => {
    try {
      await api.send(`/nodes/${encodeURIComponent(id)}/alias`, "PUT", { alias });
      setEditing(undefined);
      setNotice("节点别名已保存");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "别名保存失败");
    }
  };
  return (
    <>
      <Header
        title="代理管理"
        description="查看节点健康、延迟、负载并控制调度。"
        action={
          <button className="btn-secondary" type="button" onClick={() => void refresh()}>
            <ArrowClockwise size={18} />
            刷新状态
          </button>
        }
      />
      <Card className="mb-5 bg-[#fff1ed]">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm text-[#a84531]">网关地址</p>
            <strong className="mt-1 block text-2xl tracking-[-.03em]">
              {gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}
            </strong>
          </div>
          <Status value={snapshot.gateway.ready ? "ready" : "not-ready"} />
        </div>
      </Card>
      <Card>
        {notice ? (
          <p
            className="mb-4 rounded-xl bg-[#fff1ed] px-4 py-3 text-sm text-[#b53018]"
            role="status"
          >
            {notice}
          </p>
        ) : null}
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">节点列表</h2>
          <div className="flex gap-2">
            <select
              className="field w-auto"
              aria-label="按状态筛选节点"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">全部状态</option>
              {["healthy", "degraded", "warming", "cooldown", "disabled", "draining"].map(
                (status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ),
              )}
            </select>
            <label className="search-field">
              <MagnifyingGlass size={18} />
              <input
                aria-label="搜索节点"
                placeholder="搜索节点"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>节点</th>
                  <th>状态</th>
                  <th>延迟</th>
                  <th>连接</th>
                  <th>成功率</th>
                  <th>调度</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((node) => (
                  <tr key={node.id}>
                    <td>
                      {editing === node.id ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveAlias(node.id);
                          }}
                        >
                          <input
                            className="field max-w-40"
                            aria-label={`编辑 ${node.id} 别名`}
                            value={alias}
                            onChange={(event) => setAlias(event.target.value)}
                          />
                          <button className="icon-button" type="submit">
                            <CheckCircle />
                          </button>
                        </form>
                      ) : (
                        <button
                          className="text-left"
                          type="button"
                          onClick={() => {
                            setEditing(node.id);
                            setAlias(node.alias ?? "");
                          }}
                        >
                          <strong className="block">{node.alias ?? node.id}</strong>
                          {node.alias ? <small className="text-[#7c857f]">{node.id}</small> : null}
                        </button>
                      )}
                    </td>
                    <td>
                      <Status value={node.status} />
                    </td>
                    <td>{node.latencyMs}ms</td>
                    <td>{node.activeConnections}</td>
                    <td>
                      <span className="mr-2 inline-block h-2 w-20 overflow-hidden rounded-full bg-[#e8ebe7]">
                        <i
                          className="block h-full rounded-full bg-[#ff5538]"
                          style={{ width: `${node.successRate * 100}%` }}
                        />
                      </span>
                      {Math.round(node.successRate * 100)}%
                    </td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={node.enabled}
                        aria-label={`${node.enabled ? "停用" : "启用"} ${node.alias ?? node.id}`}
                        onClick={() => void toggle(node.id, !node.enabled)}
                        className={`relative h-7 w-12 rounded-full transition ${node.enabled ? "bg-[#ff5538]" : "bg-[#cbd1cc]"}`}
                      >
                        <i
                          className={`absolute top-1 size-5 rounded-full bg-white transition ${node.enabled ? "left-6" : "left-1"}`}
                        />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {snapshot.nodes.length === 0
              ? "还没有可调度节点，请先导入并成功应用订阅。"
              : "没有符合当前搜索或状态筛选的节点。"}
          </Empty>
        )}
      </Card>
    </>
  );
}

export function SessionsPage() {
  const { refresh, snapshot } = useConsole();
  const [query, setQuery] = useState("");
  const visible = snapshot.sessions.filter((session) =>
    `${session.id} ${session.nodeId}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <Header
        title="活跃会话"
        description="仅展示 HMAC 摘要，不暴露原始会话标识。"
        action={
          <button className="btn-primary" type="button" onClick={() => void refresh()}>
            <ArrowClockwise size={18} />
            刷新
          </button>
        }
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <Card>
          <UsersThree className="text-[#ff5538]" size={24} />
          <p className="mt-5 text-sm text-[#66706a]">活跃会话</p>
          <strong className="text-3xl">{snapshot.metrics.activeSessions}</strong>
        </Card>
        <Card>
          <LinkSimple className="text-[#ff5538]" size={24} />
          <p className="mt-5 text-sm text-[#66706a]">当前连接绑定</p>
          <strong className="text-3xl">{snapshot.sessions.length}</strong>
        </Card>
      </div>
      <Card>
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">会话列表</h2>
          <label className="search-field">
            <MagnifyingGlass size={18} />
            <input
              aria-label="搜索会话"
              placeholder="搜索摘要或节点"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {visible.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>会话摘要</th>
                  <th>模式</th>
                  <th>所属节点</th>
                  <th>当前连接</th>
                  <th>创建时间</th>
                  <th>最后活动</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <code>{session.id}</code>
                    </td>
                    <td>
                      <Status value={session.mode} />
                    </td>
                    <td>{session.nodeId}</td>
                    <td>{session.activeConnections}</td>
                    <td>{new Date(session.createdAt).toLocaleString()}</td>
                    <td>{new Date(session.lastUsedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>当前没有活跃会话</Empty>
        )}
      </Card>
    </>
  );
}

export function PlaygroundPage() {
  const { snapshot } = useConsole();
  const [mode, setMode] = useState("rotate");
  const [target, setTarget] = useState("https://httpbin.org/ip");
  const [node, setNode] = useState(snapshot.nodes[0]?.alias ?? snapshot.nodes[0]?.id ?? "node-id");
  const [proxyToken, setProxyToken] = useState("");
  const [copied, setCopied] = useState(false);
  const proxy = `http://${gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}`;
  const username =
    mode === "node"
      ? `node.${encodeProxyUsernameValue(node)}`
      : mode === "rotate"
        ? "rotate"
        : `${mode}.session-demo`;
  const command = `curl --proxy ${shellQuote(proxy)} --proxy-user "${username}:$PROXY_TOKEN" ${shellQuote(target)}`;
  const examples = [
    { label: "检查出口 IP", value: "https://httpbin.org/ip" },
    { label: "访问网站", value: "https://example.com" },
    { label: "查询隧道", value: "https://httpbin.org/anything" },
    { label: "自定义请求", value: "https://" },
  ];
  const copyCommand = async () => {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <>
      <Header
        title="快捷操作 Playground"
        description="在浏览器内生成请求命令，不会代你访问目标网站。"
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <h2 className="text-lg font-semibold">构建请求</h2>
          <div className="mt-6 space-y-5">
            <label className="field-label">
              代理模式
              <select
                className="field mt-2"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="rotate">Rotate</option>
                <option value="sticky">Soft sticky</option>
                <option value="strict">Strict sticky</option>
                <option value="node">指定节点</option>
              </select>
            </label>
            {mode === "node" ? (
              <label className="field-label">
                节点
                <input
                  className="field mt-2"
                  value={node}
                  onChange={(event) => setNode(event.target.value)}
                />
              </label>
            ) : null}
            <label className="field-label">
              目标 URL
              <input
                className="field mt-2"
                type="url"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            <label className="field-label">
              Proxy Token（仅组件内存）
              <input
                className="field mt-2"
                aria-label="Proxy Token"
                type="password"
                autoComplete="off"
                value={proxyToken}
                onChange={(event) => setProxyToken(event.target.value)}
                placeholder="可选，用于本次构建确认"
              />
            </label>
            <div className="rounded-xl bg-[#f5f6f4] p-4 text-xs leading-5 text-[#66706a]">
              <ShieldCheck className="mb-2 text-emerald-600" size={20} />
              生成与复制始终使用环境变量 <code>$PROXY_TOKEN</code>，输入值不会进入 DOM 命令、URL
              或持久化存储。
            </div>
          </div>
        </Card>
        <Card className="bg-[#202321] text-white">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">请求示例</h2>
            <button
              className="icon-button border-white/10 text-white"
              type="button"
              aria-label="复制请求命令"
              onClick={() => void copyCommand()}
            >
              {copied ? <CheckCircle size={18} /> : <Copy size={18} />}
            </button>
          </div>
          <pre className="mt-7 overflow-x-auto whitespace-pre-wrap rounded-xl bg-black/20 p-5 text-sm leading-7 text-[#f7b4a8]">
            <code>{command}</code>
          </pre>
          <p className="mt-5 flex items-center gap-2 text-xs text-white/50">
            <Code size={16} />
            请在你信任的终端中执行。
          </p>
          {copied ? (
            <p className="mt-3 text-xs text-emerald-300" role="status">
              命令已复制
            </p>
          ) : null}
        </Card>
      </div>
      <h2 className="mb-4 mt-8 text-xl font-semibold">常用示例</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {examples.map((example) => (
          <button
            className="flex items-center justify-between rounded-2xl border border-black/6 bg-white p-5 text-left"
            type="button"
            key={example.label}
            onClick={() => setTarget(example.value)}
          >
            <span>
              <strong className="block">{example.label}</strong>
              <small className="mt-1 block text-[#7c857f]">{example.value}</small>
            </span>
            <PaperPlaneTilt className="text-[#ff5538]" />
          </button>
        ))}
      </div>
    </>
  );
}

export function DocsPage() {
  const { snapshot } = useConsole();
  const proxy = `http://${gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}`;
  const sections = [
    ["1", "配置 Proxy Token", "在服务端设置独立的 Proxy Token，不要复用 Admin Token。"],
    [
      "2",
      "选择路由模式",
      "使用 rotate、sticky.<session>、strict.<session> 或 node.<selector> 作为代理用户名。",
    ],
    ["3", "发起请求", "通过标准 HTTP_PROXY / HTTPS_PROXY 或 curl --proxy 接入。"],
  ];
  return (
    <>
      <Header title="使用文档" description="从代理入口到路由模式的最短接入路径。" />
      <Card className="mb-5 bg-[#fff1ed]">
        <div className="flex items-center gap-4">
          <span className="grid size-12 place-items-center rounded-xl bg-[#ff5538] text-white">
            <CloudArrowDown size={23} />
          </span>
          <div>
            <p className="text-sm text-[#a84531]">当前代理入口</p>
            <code className="text-lg font-semibold">{proxy}</code>
          </div>
          <button
            className="icon-button ml-auto"
            type="button"
            aria-label="复制代理入口"
            onClick={() => void navigator.clipboard?.writeText(proxy)}
          >
            <Clipboard />
          </button>
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-[.65fr_1.35fr]">
        <Card>
          <h2 className="text-lg font-semibold">快速开始</h2>
          <div className="mt-6 space-y-6">
            {sections.map(([number, title, copy]) => (
              <div className="flex gap-4" key={number}>
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#202321] text-sm text-white">
                  {number}
                </span>
                <div>
                  <strong>{title}</strong>
                  <p className="mt-1 text-sm leading-6 text-[#66706a]">{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold">路由模式</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              ["rotate", "每次请求选择合适节点"],
              ["sticky.<session>", "会话可在节点失效时重新绑定"],
              ["strict.<session>", "绑定失效后拒绝自动迁移"],
              ["node.<selector>", "固定使用指定节点或别名"],
            ].map(([mode, copy]) => (
              <div className="rounded-xl bg-[#f5f6f4] p-4" key={mode}>
                <code className="font-semibold text-[#e43c20]">{mode}</code>
                <p className="mt-2 text-sm text-[#66706a]">{copy}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-xl border border-black/6 p-4">
            <p className="text-sm font-semibold">鉴权边界</p>
            <p className="mt-2 text-sm leading-6 text-[#66706a]">
              控制台与管理 API 使用 Admin Token；代理流量使用 Proxy Token。除 /live 与 /ready
              外，管理接口均需 Bearer 鉴权。
            </p>
          </div>
        </Card>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card>
          <h2 className="text-lg font-semibold">Docker 启动</h2>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-[#202321] p-4 text-xs leading-6 text-white/80">
            <code>{`docker run --rm \\\n  -v egresskit-state:/var/lib/egresskit \\\n  -p 127.0.0.1:8787:8787 \\\n  -e EGRESSKIT_ADMIN_TOKEN='…' \\\n  -e EGRESSKIT_PROXY_TOKEN='…' \\\n  ghcr.io/heyjunpenn/egresskit:VERSION`}</code>
          </pre>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold">存活与就绪</h2>
          <p className="mt-4 text-sm leading-6 text-[#66706a]">
            <code>/live</code> 表示 Node 进程存活；<code>/ready</code> 表示 Mihomo
            已就绪且至少存在一个可调度节点。这两个探针无需 Admin Token。
          </p>
        </Card>
        <Card>
          <h2 className="text-lg font-semibold">Prometheus</h2>
          <p className="mt-4 text-sm leading-6 text-[#66706a]">
            使用 <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code> 读取
            <code> /metrics</code>。指标覆盖连接、回退、节点、订阅操作与活跃会话。
          </p>
        </Card>
      </div>
    </>
  );
}

async function pollOperation(
  api: ApiClient,
  operationId: string,
  onUpdate: (operation: OperationResponse) => void,
): Promise<OperationResponse> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const operation = await api.get<OperationResponse>(
      `/operations/${encodeURIComponent(operationId)}`,
    );
    onUpdate(operation);
    if (["succeeded", "failed", "interrupted"].includes(operation.status)) return operation;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("操作仍在后台执行，请稍后刷新查看");
}

async function observeOperation(
  api: ApiClient,
  operationId: string,
  setNotice: (notice: string) => void,
  refresh: () => Promise<void>,
): Promise<boolean> {
  try {
    const operation = await pollOperation(api, operationId, (current) => {
      setNotice(`任务 ${operationId}：${current.status}`);
    });
    if (operation.status === "failed") {
      setNotice(
        `任务失败（${operation.failure?.stage ?? "unknown"}）：${operation.failure?.reason ?? "请重试"}`,
      );
      return false;
    }
    if (operation.status === "interrupted") {
      setNotice("任务因服务重启被中断，可点击刷新重试");
      return false;
    }
    setNotice(`任务 ${operationId} 已完成`);
    await refresh();
    return true;
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "无法读取任务进度，请重试");
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function encodeProxyUsernameValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function gatewayAddress(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? window.location.hostname : host;
  const normalizedHost = displayHost.replace(/^\[(.*)]$/, "$1");
  const urlHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return `${urlHost}:${port}`;
}
