import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  MagnifyingGlass,
  Plus,
  Pulse,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useConsole } from "./App";
import type { ApiClient, ConsoleSnapshot, OperationResponse } from "./api";
import { AnimatedBadge, type AnimatedBadgeStatus } from "./components/motion/animated-badge";
import { Button } from "./components/motion/button/base";
import { Input } from "./components/motion/input";
import { NumberTicker } from "./components/motion/number-ticker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/motion/select";
import { Switch } from "./components/motion/switch";
import { Table, type TableColumn } from "./components/motion/table";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { gatewayAddress } from "./lib/gateway-address";

export { gatewayAddress } from "./lib/gateway-address";

type Subscription = ConsoleSnapshot["subscriptions"][number];
type Node = ConsoleSnapshot["nodes"][number];
type Session = ConsoleSnapshot["sessions"][number];

function statusVariant(value: string): AnimatedBadgeStatus {
  if (["healthy", "ready", "succeeded", "accepted"].includes(value)) return "success";
  if (["degraded", "warming", "pending", "suspicious", "cooldown", "draining"].includes(value)) {
    return "warning";
  }
  if (["failed", "interrupted", "not-ready", "removed"].includes(value)) return "danger";
  if (
    [
      "saved",
      "downloaded",
      "parsed",
      "validated",
      "fetching",
      "parsing",
      "validating",
      "applying",
      "checking",
      "queued",
    ].includes(value)
  ) {
    return "info";
  }
  return "neutral";
}

const statusLabels: Record<string, string> = {
  accepted: "已接受",
  applying: "应用中",
  checking: "健康检查中",
  cooldown: "冷却中",
  degraded: "降级",
  disabled: "已停用",
  downloaded: "已下载",
  failed: "失败",
  fetching: "下载中",
  healthy: "健康",
  interrupted: "已中断",
  "not-ready": "未就绪",
  parsed: "已解析",
  parsing: "解析中",
  pending: "等待中",
  queued: "排队中",
  ready: "就绪",
  removed: "已移除",
  saved: "已保存",
  succeeded: "成功",
  suspicious: "可疑",
  validated: "已验证",
  validating: "校验中",
  warming: "预热中",
};

function statusLabel(value: string): string {
  return statusLabels[value] ?? value;
}

function StatusBadge({ value }: { value: string }) {
  return (
    <AnimatedBadge status={statusVariant(value)} contentKey={value} size="sm">
      {statusLabel(value)}
    </AnimatedBadge>
  );
}

function tableHeight(rows: number): number {
  return Math.max(144, 48 + rows * 48);
}

function Modal({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose(): void;
  title: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="modal-title"
      className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-2xl bg-background p-0 text-foreground shadow-xl backdrop:bg-foreground/35 backdrop:backdrop-blur-[2px]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex items-center justify-between gap-4 px-6 pt-6">
        <h2 id="modal-title" className="text-lg font-semibold">
          {title}
        </h2>
        <Button variant="ghost" size="icon" aria-label="关闭弹窗" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function OverviewPage() {
  const { connectionSamples, refresh, snapshot } = useConsole();
  const { metrics } = snapshot;
  const gateway = `http://${gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}`;
  const [copied, setCopied] = useState(false);
  const lifecycleStatuses = [
    "warming",
    "healthy",
    "degraded",
    "cooldown",
    "draining",
    "disabled",
  ] as const;
  const lifecycleNodeCount = lifecycleStatuses.reduce(
    (total, status) => total + (snapshot.nodeStatusCounts[status] ?? 0),
    0,
  );
  const copyGateway = async () => {
    await navigator.clipboard?.writeText(gateway);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };
  const stats = [
    {
      label: "健康节点",
      value: metrics.healthyNodes,
      suffix: ` / ${metrics.totalNodes}`,
      icon: Pulse,
      iconClassName: "text-success",
    },
    {
      label: "活跃会话",
      value: metrics.activeSessions,
      icon: UsersThree,
      iconClassName: "text-foreground",
    },
    {
      label: "本次运行成功连接",
      value: metrics.successConnections,
      icon: CheckCircle,
      iconClassName: "text-success",
    },
    {
      label: "本次运行失败连接",
      value: metrics.failedConnections,
      icon: WarningCircle,
      iconClassName: "text-destructive",
    },
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-foreground px-5 py-6 text-background sm:px-6 md:px-8 md:py-8">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">代理入口</h2>
              <StatusBadge value={snapshot.gateway.ready ? "ready" : "not-ready"} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-background/65">HTTP 代理地址</p>
              <code className="mt-2 block truncate text-xl font-semibold sm:text-2xl">
                {gateway}
              </code>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-background/75 hover:bg-background/10 hover:text-background"
              onClick={() => void refresh()}
            >
              <ArrowClockwise size={16} />
              刷新
            </Button>
            <Button
              size="sm"
              className="bg-background text-foreground hover:bg-background/90"
              onClick={() => void copyGateway()}
            >
              {copied ? <CheckCircle size={16} /> : <Copy size={16} />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </div>
      </section>

      <section
        aria-label="关键指标"
        className="grid grid-cols-2 gap-x-6 gap-y-7 rounded-2xl bg-card px-5 py-7 sm:grid-cols-4 sm:px-6 md:px-8 md:py-8"
      >
        {stats.map(({ icon: Icon, iconClassName, label, suffix, value }) => (
          <div className="flex min-w-0 items-start gap-3" key={label}>
            <Icon aria-hidden className={`mt-0.5 shrink-0 ${iconClassName}`} size={18} />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{label}</p>
              <NumberTicker
                value={value}
                locale
                suffix={suffix}
                className="mt-1 block text-xl font-semibold"
              />
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl bg-muted px-5 py-7 sm:px-6 md:px-8">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-semibold">节点生命周期</h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            共 {lifecycleNodeCount} 个节点
          </span>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {lifecycleStatuses.map((status) => (
            <div className="flex items-center justify-between gap-4 py-1 sm:block" key={status}>
              <StatusBadge value={status} />
              <NumberTicker
                value={snapshot.nodeStatusCounts[status] ?? 0}
                className="text-lg font-semibold sm:mt-3 sm:block"
              />
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-8 md:grid-cols-2">
        <section className="rounded-2xl bg-card px-5 py-7 sm:px-6 md:px-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">连接采样</h2>
            <span className="text-xs text-muted-foreground">
              最近 {connectionSamples.length} 次
            </span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {connectionSamples.length ? (
              connectionSamples.slice(-6).map((sample) => (
                <AnimatedBadge key={sample.at} status="info" showIcon={false}>
                  {new Date(sample.at).toLocaleTimeString()} · {sample.value}
                </AnimatedBadge>
              ))
            ) : (
              <AnimatedBadge status="neutral">等待下一次采样</AnimatedBadge>
            )}
          </div>
        </section>

        <section className="rounded-2xl bg-card px-5 py-7 sm:px-6 md:px-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">最近操作</h2>
            {snapshot.operations[0] ? (
              <span className="text-xs text-muted-foreground">
                {new Date(snapshot.operations[0].updatedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
          <div className="mt-4 divide-y divide-border">
            {snapshot.operations.slice(0, 4).map((operation) => (
              <div
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                key={operation.id}
              >
                <div className="min-w-0">
                  <strong className="block truncate text-sm">{operation.subscriptionId}</strong>
                  <p className="text-xs text-muted-foreground">
                    {new Date(operation.updatedAt).toLocaleString()}
                  </p>
                </div>
                <StatusBadge value={operation.status} />
              </div>
            ))}
            {snapshot.operations.length === 0 ? (
              <AnimatedBadge status="neutral">暂无控制面操作</AnimatedBadge>
            ) : null}
          </div>
        </section>
      </div>
    </div>
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

  const columns: TableColumn<Subscription>[] = [
    {
      key: "id",
      header: "订阅",
      width: "12rem",
      sortable: true,
      cell: (item) => <strong>{item.id}</strong>,
    },
    {
      key: "locator",
      header: "来源",
      width: "20rem",
      cell: (item) => (item.kind === "remote" ? item.locator : "本地配置"),
    },
    { key: "nodeCount", header: "节点", width: "7rem", sortable: true },
    {
      key: "status",
      header: "状态",
      width: "9rem",
      sortable: true,
      cell: (item) => <StatusBadge value={item.status} />,
    },
    {
      key: "updatedAt",
      header: "最近更新",
      width: "13rem",
      sortValue: (item) => item.updatedAt ?? "",
      cell: (item) => (item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "等待首次刷新"),
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      width: "10rem",
      cell: (item) => (
        <div className="flex justify-end gap-2">
          {item.status === "suspicious" && item.revisionId ? (
            <Button size="sm" onClick={() => void forceRevision(item.revisionId as number)}>
              强制应用
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="icon"
            aria-label={`刷新 ${item.id}`}
            onClick={() => void refreshSubscription(item.id)}
          >
            <ArrowClockwise size={17} />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {adding ? (
        <Modal
          title="添加订阅"
          onClose={() => {
            setAdding(false);
            setNotice("");
          }}
        >
          <form className="space-y-5 px-6 pb-6 pt-5" onSubmit={submit}>
            <div className="space-y-4">
              <Select value={kind} onValueChange={(next) => setKind(next as "local" | "remote")}>
                <SelectTrigger ariaLabel="订阅类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="remote">远程 URL</SelectItem>
                  <SelectItem value="local">本地 YAML</SelectItem>
                </SelectContent>
              </Select>
              {kind === "remote" ? (
                <Input
                  aria-label="订阅 URL"
                  type="url"
                  required
                  placeholder="https://provider.example/sub"
                  value={value}
                  onChange={setValue}
                />
              ) : (
                <Textarea
                  className="min-h-28"
                  aria-label="订阅 YAML"
                  required
                  placeholder="粘贴本地 YAML"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </div>
            {notice ? (
              <p className="text-sm text-destructive" role="alert">
                {notice}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                取消
              </Button>
              <Button type="submit">导入</Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {notice && !adding ? (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          role={retryAction ? "alert" : "status"}
        >
          <StatusBadge value={retryAction ? "failed" : "pending"} />
          <p className="min-w-0 flex-1 break-words">{notice}</p>
          {retryAction ? (
            <Button variant="ghost" size="sm" onClick={retryAction}>
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[10rem_12rem_minmax(14rem,1fr)_auto]">
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger ariaLabel="按来源筛选订阅">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                <SelectItem value="remote">远程</SelectItem>
                <SelectItem value="local">本地</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger ariaLabel="按状态筛选订阅">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
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
                  <SelectItem key={status} value={status}>
                    {statusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="搜索订阅"
              placeholder="搜索订阅"
              value={query}
              onChange={setQuery}
              leftIcon={<MagnifyingGlass size={18} />}
            />
            <Button
              onClick={() => {
                setNotice("");
                setAdding(true);
              }}
            >
              <Plus size={18} />
              添加订阅
            </Button>
          </div>
          <Table
            data={visible}
            columns={columns}
            getRowId={(item) => item.id}
            rowHeight={48}
            height={tableHeight(visible.length)}
            emptyState={
              snapshot.subscriptions.length === 0
                ? "还没有订阅，使用“添加订阅”导入第一个来源。"
                : "没有符合搜索条件的订阅。"
            }
          />
        </CardContent>
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

  const columns: TableColumn<Node>[] = [
    {
      key: "id",
      header: "节点",
      width: "18rem",
      sortable: true,
      sortValue: (node) => node.alias ?? node.id,
      cell: (node) =>
        editing === node.id ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAlias(node.id);
            }}
          >
            <Input
              aria-label={`编辑 ${node.id} 别名`}
              value={alias}
              onChange={setAlias}
              className="max-w-44"
            />
            <Button variant="secondary" size="icon" type="submit" aria-label="保存别名">
              <CheckCircle />
            </Button>
          </form>
        ) : (
          <Button
            variant="ghost"
            className="h-auto justify-start px-0 py-1 text-left"
            onClick={() => {
              setEditing(node.id);
              setAlias(node.alias ?? "");
            }}
          >
            <span>
              <strong className="block">{node.alias ?? node.id}</strong>
              {node.alias ? <small className="text-muted-foreground">{node.id}</small> : null}
            </span>
          </Button>
        ),
    },
    {
      key: "status",
      header: "状态",
      width: "9rem",
      sortable: true,
      cell: (node) => <StatusBadge value={node.status} />,
    },
    {
      key: "latencyMs",
      header: "延迟",
      width: "8rem",
      sortable: true,
      cell: (node) => `${node.latencyMs}ms`,
    },
    {
      key: "activeConnections",
      header: "连接",
      width: "8rem",
      sortable: true,
      cell: (node) => <NumberTicker value={node.activeConnections} />,
    },
    {
      key: "successRate",
      header: "成功率",
      width: "9rem",
      sortable: true,
      cell: (node) => (
        <NumberTicker value={node.successRate * 100} suffix="%" className="font-medium" />
      ),
    },
    {
      key: "enabled",
      header: "调度",
      width: "8rem",
      cell: (node) => (
        <Switch
          checked={node.enabled}
          ariaLabel={`${node.enabled ? "停用" : "启用"} ${node.alias ?? node.id}`}
          onCheckedChange={(enabled) => void toggle(node.id, enabled)}
        />
      ),
    },
  ];

  return (
    <>
      {notice ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
          role="status"
        >
          <StatusBadge value="accepted" />
          <p className="min-w-0 flex-1 break-words">{notice}</p>
        </div>
      ) : null}
      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[13rem_minmax(14rem,1fr)_auto]">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger ariaLabel="按状态筛选节点">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {["healthy", "degraded", "warming", "cooldown", "disabled", "draining"].map(
                  (status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabel(status)}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <Input
              aria-label="搜索节点"
              placeholder="搜索节点"
              value={query}
              onChange={setQuery}
              leftIcon={<MagnifyingGlass size={18} />}
            />
            <Button variant="secondary" onClick={() => void refresh()}>
              <ArrowClockwise size={18} />
              刷新状态
            </Button>
          </div>
          <Table
            data={visible}
            columns={columns}
            getRowId={(node) => node.id}
            rowHeight={56}
            height={tableHeight(visible.length)}
            emptyState={
              snapshot.nodes.length === 0
                ? "还没有可调度节点，请先导入并成功应用订阅。"
                : "没有符合当前搜索或状态筛选的节点。"
            }
          />
        </CardContent>
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
  const columns: TableColumn<Session>[] = [
    {
      key: "id",
      header: "会话摘要",
      width: "17rem",
      cell: (session) => <code>{session.id}</code>,
    },
    {
      key: "mode",
      header: "模式",
      width: "8rem",
      sortable: true,
      cell: (session) => (
        <code className="rounded-md bg-card px-2 py-1 text-xs font-medium">{session.mode}</code>
      ),
    },
    { key: "nodeId", header: "所属节点", width: "13rem", sortable: true },
    {
      key: "activeConnections",
      header: "当前连接",
      width: "9rem",
      sortable: true,
      cell: (session) => <NumberTicker value={session.activeConnections} />,
    },
    {
      key: "createdAt",
      header: "创建时间",
      width: "13rem",
      sortable: true,
      cell: (session) => new Date(session.createdAt).toLocaleString(),
    },
    {
      key: "lastUsedAt",
      header: "最后活动",
      width: "13rem",
      sortable: true,
      cell: (session) => new Date(session.lastUsedAt).toLocaleString(),
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_auto]">
          <Input
            aria-label="搜索会话"
            placeholder="搜索摘要或节点"
            value={query}
            onChange={setQuery}
            leftIcon={<MagnifyingGlass size={18} />}
          />
          <Button onClick={() => void refresh()}>
            <ArrowClockwise size={18} />
            刷新
          </Button>
        </div>
        <Table
          data={visible}
          columns={columns}
          getRowId={(session) => session.id}
          rowHeight={48}
          height={tableHeight(visible.length)}
          emptyState="当前没有活跃会话。客户端使用 sticky 或 strict 模式建立连接后，会话会显示在这里。"
        />
      </CardContent>
    </Card>
  );
}

export function PlaygroundPage() {
  const { snapshot } = useConsole();
  const [mode, setMode] = useState("rotate");
  const [target, setTarget] = useState("https://httpbin.org/ip");
  const [node, setNode] = useState(snapshot.nodes[0]?.alias ?? snapshot.nodes[0]?.id ?? "node-id");
  const [copied, setCopied] = useState(false);
  const proxy = `http://${gatewayAddress(snapshot.gateway.host, snapshot.gateway.port)}`;
  const username =
    mode === "node"
      ? `node.${encodeProxyUsernameValue(node)}`
      : mode === "rotate"
        ? "rotate"
        : `${mode}.session-demo`;
  const command = `curl --proxy ${shellQuote(proxy)} --proxy-user "${username}:PROXY_TOKEN" ${shellQuote(target)}`;
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
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>构建请求</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-1.5 px-1 text-sm font-medium">代理模式</p>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger ariaLabel="代理模式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rotate">Rotate</SelectItem>
                <SelectItem value="sticky">Soft sticky</SelectItem>
                <SelectItem value="strict">Strict sticky</SelectItem>
                <SelectItem value="node">指定节点</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "node" ? <Input label="节点" value={node} onChange={setNode} /> : null}
          <Input label="目标 URL" type="url" value={target} onChange={setTarget} />
          <div className="grid gap-2 sm:grid-cols-2">
            {examples.map((example) => (
              <Button
                variant="secondary"
                size="sm"
                className="h-auto min-w-0 justify-start px-3 py-2 text-left"
                key={example.label}
                onClick={() => setTarget(example.value)}
              >
                <span className="min-w-0">
                  <strong className="block truncate font-medium">{example.label}</strong>
                  <small className="block truncate font-mono text-muted-foreground">
                    {example.value}
                  </small>
                </span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>请求示例</h2>
          </CardTitle>
          <CardAction>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制请求命令"
              onClick={() => void copyCommand()}
            >
              {copied ? <CheckCircle size={18} /> : <Copy size={18} />}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-foreground p-4 text-sm leading-6 text-background">
            <code>{command}</code>
          </pre>
          {copied ? (
            <div className="mt-4 text-sm text-success" role="status" aria-live="polite">
              命令已复制
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
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
      setNotice(`任务 ${operationId}：${statusLabel(current.status)}`);
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
