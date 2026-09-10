import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Pulse,
  Trash,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useConsole } from "./App";
import type {
  ApiClient,
  ConsoleSnapshot,
  OperationResponse,
  RuntimeSettings,
  SettingsResponse,
} from "./api";
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
import { Tooltip } from "./components/motion/tooltip";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { useToast } from "./components/ui/toast";
import { gatewayUrl } from "./lib/gateway-address";

export { gatewayAddress, gatewayUrl } from "./lib/gateway-address";

type Subscription = ConsoleSnapshot["subscriptions"][number];
type Node = ConsoleSnapshot["nodes"][number];
type Session = ConsoleSnapshot["sessions"][number];
type PlaygroundResult = {
  body: string;
  durationMs: number;
  headers: Record<string, string | string[]>;
  status: number;
};
type PlaygroundLog = {
  error?: string;
  id: string;
  mode: string;
  node?: string;
  requestedAt: string;
  result?: PlaygroundResult;
  target: string;
};

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
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return () => {
      if (dialog && typeof dialog.close === "function") dialog.close();
      else dialog?.removeAttribute("open");
    };
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
        <Tooltip content="关闭">
          <Button variant="ghost" size="icon" aria-label="关闭弹窗" onClick={onClose}>
            <X size={18} />
          </Button>
        </Tooltip>
      </div>
      {children}
    </dialog>
  );
}

export function OverviewPage() {
  const { refresh, snapshot } = useConsole();
  const toast = useToast();
  const { metrics } = snapshot;
  const activeProxies = snapshot.nodes
    .filter((node) => node.activeConnections > 0)
    .sort((left, right) => right.activeConnections - left.activeConnections)
    .slice(0, 4);
  const gateway = gatewayUrl(snapshot.gateway.host, snapshot.gateway.port);
  const [refreshing, setRefreshing] = useState(false);
  const refreshOverview = async () => {
    setRefreshing(true);
    try {
      await refresh();
      toast({ message: "运行状态已刷新", variant: "success" });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "刷新失败", variant: "error" });
    } finally {
      setRefreshing(false);
    }
  };
  const copyGateway = async () => {
    try {
      await navigator.clipboard?.writeText(gateway);
      toast({ message: "代理入口已复制", variant: "success" });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "复制失败", variant: "error" });
    }
  };
  const stats = [
    {
      label: "订阅数",
      value: snapshot.subscriptions.length,
      icon: Plus,
      iconClassName: "text-foreground",
    },
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
              loading={refreshing}
              onClick={() => void refreshOverview()}
            >
              <ArrowClockwise size={16} />
              刷新
            </Button>
            <Button
              size="sm"
              className="bg-background text-foreground hover:bg-background/90"
              onClick={() => void copyGateway()}
            >
              <Copy size={16} />
              复制
            </Button>
          </div>
        </div>
      </section>

      <section
        aria-label="关键指标"
        className="grid grid-cols-2 gap-x-6 gap-y-7 rounded-2xl bg-card px-5 py-7 sm:grid-cols-3 sm:px-6 lg:grid-cols-5 md:px-8 md:py-8"
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

      <div className="grid gap-8 md:grid-cols-2">
        <section className="rounded-2xl bg-card px-5 py-7 sm:px-6 md:px-8">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">活跃代理</h2>
              <p className="mt-1 text-xs text-muted-foreground">当前正在处理连接的代理节点</p>
            </div>
            <span className="text-xs text-muted-foreground">{activeProxies.length} 个</span>
          </div>
          <div className="mt-4 divide-y divide-border">
            {activeProxies.length ? (
              activeProxies.map((node) => (
                <div
                  className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  key={node.id}
                >
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">
                      {node.alias ?? nodeDisplayName(node.id)}
                    </strong>
                    <p className="text-xs text-muted-foreground">当前活动连接</p>
                  </div>
                  <AnimatedBadge status="success" showIcon={false}>
                    {node.activeConnections} 个
                  </AnimatedBadge>
                </div>
              ))
            ) : (
              <AnimatedBadge status="neutral">暂无活跃代理</AnimatedBadge>
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
                  <strong className="block text-sm">
                    {operation.kind === "force" ? "强制应用订阅" : "同步订阅"}
                  </strong>
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
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<Subscription>();
  const [deletingSubscription, setDeletingSubscription] = useState<Subscription>();
  const [forcingRevisionId, setForcingRevisionId] = useState<number>();
  const [kind, setKind] = useState<"local" | "remote">("remote");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [pendingAction, setPendingAction] = useState<string>();

  const watchOperation = (operation: OperationResponse, retry: () => void) => {
    void observeOperation(api, operation.operationId, toast, refresh).then((succeeded) => {
      if (!succeeded) void retry;
    });
  };
  const visible = snapshot.subscriptions.filter(
    (item) =>
      (sourceFilter === "all" || item.kind === sourceFilter) &&
      (statusFilter === "all" || item.status === statusFilter) &&
      `${item.id} ${item.name} ${item.locator}`.toLowerCase().includes(query.toLowerCase()),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPendingAction("add");
    try {
      const operation =
        kind === "remote"
          ? await api.send<OperationResponse>("/subscriptions/remote", "POST", {
              name,
              url: value,
            })
          : await api.sendText<{ nodes: unknown[] }>("/subscriptions/local", value);
      toast({
        message: "operationId" in operation ? "订阅已保存，正在同步" : "本地订阅已应用",
        variant: "success",
      });
      setValue("");
      setName("");
      setAdding(false);
      await refresh();
      if ("operationId" in operation) {
        watchOperation(operation, () => void refreshSubscription(operation.subscriptionId));
      }
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "添加失败", variant: "error" });
    } finally {
      setPendingAction(undefined);
    }
  };
  const refreshSubscription = async (id: string) => {
    setPendingAction(`refresh:${id}`);
    try {
      const operation = await api.send<OperationResponse>(
        `/subscriptions/${encodeURIComponent(id)}/refresh`,
        "POST",
      );
      toast({ message: "订阅刷新已开始", variant: "success" });
      await refresh();
      watchOperation(operation, () => void refreshSubscription(id));
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : "刷新失败，请重试",
        variant: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  };
  const updateSubscription = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingSubscription) return;
    setPendingAction("edit");
    try {
      const operation = await api.send<OperationResponse>(
        `/subscriptions/${encodeURIComponent(editingSubscription.id)}`,
        "PUT",
        { name, url: value },
      );
      setEditingSubscription(undefined);
      setValue("");
      setName("");
      toast({ message: "订阅地址已更新，正在同步", variant: "success" });
      await refresh();
      watchOperation(operation, () => void refreshSubscription(editingSubscription.id));
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : "订阅更新失败",
        variant: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  };
  const deleteSubscription = async (id: string) => {
    setPendingAction(`delete:${id}`);
    try {
      await api.send(`/subscriptions/${encodeURIComponent(id)}`, "DELETE");
      setDeletingSubscription(undefined);
      toast({ message: "订阅已删除", variant: "success" });
      await refresh();
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : "订阅删除失败",
        variant: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  };
  const forceRevision = async (revisionId: number) => {
    setPendingAction(`force:${revisionId}`);
    try {
      const operation = await api.send<OperationResponse>(`/revisions/${revisionId}/force`, "POST");
      setForcingRevisionId(undefined);
      toast({ message: "强制应用任务已开始", variant: "success" });
      watchOperation(operation, () => void forceRevision(revisionId));
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : "强制应用失败，请重试",
        variant: "error",
      });
    } finally {
      setPendingAction(undefined);
    }
  };

  const columns: TableColumn<Subscription>[] = [
    {
      key: "sequence",
      header: "序号",
      width: "5rem",
      cell: (_item, index) => index + 1,
    },
    {
      key: "name",
      header: "名称",
      width: "12rem",
      sortable: true,
      cell: (item) => <strong>{item.name}</strong>,
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
      width: "14rem",
      cell: (item) => (
        <div className="flex justify-end gap-2">
          {item.status === "suspicious" && item.revisionId ? (
            <Button size="sm" onClick={() => setForcingRevisionId(item.revisionId as number)}>
              强制应用
            </Button>
          ) : null}
          <Tooltip content="刷新订阅">
            <Button
              variant="secondary"
              size="icon"
              aria-label={`刷新 ${item.id}`}
              loading={pendingAction === `refresh:${item.id}`}
              onClick={() => void refreshSubscription(item.id)}
            >
              <ArrowClockwise size={17} />
            </Button>
          </Tooltip>
          {item.kind === "remote" ? (
            <Tooltip content="编辑订阅">
              <Button
                variant="secondary"
                size="icon"
                aria-label={`编辑 ${item.id}`}
                onClick={() => {
                  setValue("");
                  setName(item.name);
                  setEditingSubscription(item);
                }}
              >
                <PencilSimple size={17} />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content="删除订阅">
            <Button
              size="icon"
              className="bg-destructive text-white hover:bg-destructive/90"
              aria-label={`删除 ${item.id}`}
              onClick={() => setDeletingSubscription(item)}
            >
              <Trash size={17} />
            </Button>
          </Tooltip>
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
                <div className="space-y-4">
                  <Input
                    aria-label="订阅名称"
                    placeholder="可选，默认使用订阅域名"
                    value={name}
                    onChange={setName}
                  />
                  <Input
                    aria-label="订阅 URL"
                    type="url"
                    required
                    placeholder="https://provider.example/sub"
                    value={value}
                    onChange={setValue}
                  />
                </div>
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
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                取消
              </Button>
              <Button type="submit" loading={pendingAction === "add"}>
                导入
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {editingSubscription ? (
        <Modal
          title="编辑订阅"
          onClose={() => {
            setEditingSubscription(undefined);
            setValue("");
            setName("");
          }}
        >
          <form className="space-y-5 px-6 pb-6 pt-5" onSubmit={updateSubscription}>
            <p className="text-sm text-muted-foreground">
              当前地址：{editingSubscription.locator}。为保护凭据，管理端不会返回完整 URL。
            </p>
            <Input
              aria-label="订阅名称"
              placeholder="可选，默认使用订阅域名"
              value={name}
              onChange={setName}
            />
            <Input
              aria-label="新的订阅 URL"
              type="url"
              required
              placeholder="https://provider.example/sub"
              value={value}
              onChange={setValue}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditingSubscription(undefined);
                  setName("");
                }}
              >
                取消
              </Button>
              <Button type="submit" loading={pendingAction === "edit"}>
                保存并同步
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {deletingSubscription ? (
        <Modal title="删除订阅" onClose={() => setDeletingSubscription(undefined)}>
          <div className="space-y-6 px-6 pb-6 pt-5">
            <p className="text-sm leading-6 text-muted-foreground">
              确定删除“{deletingSubscription.name}”吗？删除后，其节点将停止接收新连接。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeletingSubscription(undefined)}>
                取消
              </Button>
              <Button
                className="bg-destructive text-white hover:bg-destructive/90"
                loading={pendingAction === `delete:${deletingSubscription.id}`}
                onClick={() => void deleteSubscription(deletingSubscription.id)}
              >
                确认删除
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {forcingRevisionId !== undefined ? (
        <Modal title="强制应用订阅" onClose={() => setForcingRevisionId(undefined)}>
          <div className="space-y-6 px-6 pb-6 pt-5">
            <p className="text-sm leading-6 text-muted-foreground">
              该版本被判定为可疑，强制应用可能显著改变当前节点池。确定继续吗？
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForcingRevisionId(undefined)}>
                取消
              </Button>
              <Button
                loading={pendingAction === `force:${forcingRevisionId}`}
                onClick={() => void forceRevision(forcingRevisionId)}
              >
                确认应用
              </Button>
            </div>
          </div>
        </Modal>
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
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [exitIpFilter, setExitIpFilter] = useState("all");
  const [editing, setEditing] = useState<string>();
  const [savingAlias, setSavingAlias] = useState(false);
  const [alias, setAlias] = useState("");
  const [verifying, setVerifying] = useState<string>();
  const [verifyingAll, setVerifyingAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const exitIpOptions = snapshot.exitIps;
  const visible = snapshot.nodes.filter(
    (node) =>
      (filter === "all" || node.status === filter) &&
      (exitIpFilter === "all" || node.exitIp === exitIpFilter) &&
      `${node.id} ${node.alias ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.send(`/nodes/${encodeURIComponent(id)}/enabled`, "PUT", { enabled });
      toast({
        message: enabled ? "节点已重新加入健康评估" : "节点已停止接收新分配",
        variant: "success",
      });
      await refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "节点更新失败", variant: "error" });
    }
  };
  const saveAlias = async (id: string) => {
    setSavingAlias(true);
    try {
      await api.send(`/nodes/${encodeURIComponent(id)}/alias`, "PUT", { alias });
      setEditing(undefined);
      toast({ message: "节点别名已保存", variant: "success" });
      await refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "别名保存失败", variant: "error" });
    } finally {
      setSavingAlias(false);
    }
  };
  const verifyExit = async (node: Node) => {
    setVerifying(node.id);
    try {
      const identity = await api.send<{ city?: string; country?: string; ip: string }>(
        `/nodes/${encodeURIComponent(node.id)}/verify-exit`,
        "POST",
      );
      toast({ message: `出口验证成功：${identity.ip}`, variant: "success" });
      await refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "出口验证失败", variant: "error" });
    } finally {
      setVerifying(undefined);
    }
  };
  const verifyAllExits = async () => {
    setVerifyingAll(true);
    try {
      const result = await api.send<{ failed: number; succeeded: number; total: number }>(
        "/nodes/verify-exits",
        "POST",
      );
      toast({
        message: `出口 IP 验证完成：${result.succeeded}/${result.total}`,
        variant: result.failed === 0 ? "success" : "error",
      });
      await refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "全量验证失败", variant: "error" });
    } finally {
      setVerifyingAll(false);
    }
  };
  const refreshNodes = async () => {
    setRefreshing(true);
    try {
      await refresh();
      toast({ message: "代理状态已刷新", variant: "success" });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "刷新失败", variant: "error" });
    } finally {
      setRefreshing(false);
    }
  };

  const columns: TableColumn<Node>[] = [
    {
      key: "sequence",
      header: "序号",
      width: "4rem",
      cell: (_node, index) => index + 1,
    },
    {
      key: "id",
      header: "节点",
      sortable: true,
      sortValue: (node) => node.alias ?? nodeDisplayName(node.id),
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
            <Tooltip content="保存别名">
              <Button
                variant="secondary"
                size="icon"
                type="submit"
                aria-label="保存别名"
                loading={savingAlias}
              >
                <CheckCircle />
              </Button>
            </Tooltip>
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
            <strong className="block truncate">{node.alias ?? nodeDisplayName(node.id)}</strong>
          </Button>
        ),
    },
    {
      key: "exitIp",
      header: "出口 IP",
      width: "10rem",
      sortable: true,
      sortValue: (node) => node.exitIp ?? "",
      cell: (node) => (
        <div className="leading-tight">
          <span className="font-mono text-sm">{node.exitIp ?? "—"}</span>
          {node.exitLocation ? (
            <span className="mt-1 block text-xs text-muted-foreground">{node.exitLocation}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "状态",
      width: "8rem",
      sortable: true,
      cell: (node) => <StatusBadge value={node.status} />,
    },
    {
      key: "latencyMs",
      header: "延迟",
      width: "6rem",
      sortable: true,
      cell: (node) => `${node.latencyMs}ms`,
    },
    {
      key: "activeConnections",
      header: "连接",
      width: "6rem",
      sortable: true,
      cell: (node) => <NumberTicker value={node.activeConnections} />,
    },
    {
      key: "successRate",
      header: "成功率",
      width: "7rem",
      sortable: true,
      cell: (node) => (
        <NumberTicker value={node.successRate * 100} suffix="%" className="font-medium" />
      ),
    },
    {
      key: "enabled",
      header: "调度",
      width: "6rem",
      cell: (node) => (
        <Switch
          checked={node.enabled}
          ariaLabel={`${node.enabled ? "停用" : "启用"} ${node.alias ?? node.id}`}
          onCheckedChange={(enabled) => void toggle(node.id, enabled)}
        />
      ),
    },
    {
      key: "actions",
      header: "操作",
      width: "5rem",
      cell: (node) => (
        <Tooltip content="验证出口 IP">
          <Button
            variant="secondary"
            size="icon"
            aria-label={`验证 ${node.alias ?? nodeDisplayName(node.id)} 出口 IP`}
            loading={verifying === node.id}
            onClick={() => void verifyExit(node)}
          >
            <Pulse size={17} />
          </Button>
        </Tooltip>
      ),
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[12rem_15rem_minmax(14rem,1fr)_auto_auto]">
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
          <Select value={exitIpFilter} onValueChange={setExitIpFilter}>
            <SelectTrigger ariaLabel="按出口 IP 筛选节点">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部出口 IP</SelectItem>
              {exitIpOptions.map(({ ip, location, nodeCount }) => (
                <SelectItem key={ip} value={ip}>
                  {location ? `${ip} · ${location}` : ip}（{nodeCount}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="搜索节点"
            placeholder="搜索节点"
            value={query}
            onChange={setQuery}
            leftIcon={<MagnifyingGlass size={18} />}
          />
          <Button variant="secondary" loading={refreshing} onClick={() => void refreshNodes()}>
            <ArrowClockwise size={18} />
            刷新状态
          </Button>
          <Button loading={verifyingAll} onClick={() => void verifyAllExits()}>
            <Pulse size={18} />
            验证全部出口 IP
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
  );
}

export function SessionsPage() {
  const { refresh, snapshot } = useConsole();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const visible = snapshot.sessions.filter((session) =>
    `${session.id} ${session.nodeId}`.toLowerCase().includes(query.toLowerCase()),
  );
  const refreshSessions = async () => {
    setRefreshing(true);
    try {
      await refresh();
      toast({ message: "会话状态已刷新", variant: "success" });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "刷新失败", variant: "error" });
    } finally {
      setRefreshing(false);
    }
  };
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
          <Button loading={refreshing} onClick={() => void refreshSessions()}>
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

export function SettingsPage() {
  const { api } = useConsole();
  const toast = useToast();
  const [settings, setSettings] = useState<RuntimeSettings>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .get<SettingsResponse>("/settings")
      .then((result) => setSettings(result.settings))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "无法读取设置");
      });
  }, [api]);

  const update = <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };
  const persist = async (next: RuntimeSettings) => {
    setSaving(true);
    setError("");
    try {
      const result = await api.send<SettingsResponse>("/settings", "PUT", next);
      setSettings(result.settings);
      toast({
        message: result.restartRequired
          ? "设置已保存，部分修改将在重启服务后生效。"
          : "设置已保存并生效。",
        variant: "success",
      });
    } catch (cause) {
      toast({ message: cause instanceof Error ? cause.message : "保存设置失败", variant: "error" });
    } finally {
      setSaving(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (settings) void persist(settings);
  };

  if (!settings)
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        {error || "正在读取设置…"}
      </div>
    );
  const numberField = (key: keyof RuntimeSettings, label: string, suffix?: string) => (
    <div className="space-y-2 text-sm">
      <Input
        label={suffix ? `${label}（${suffix}）` : label}
        type="number"
        value={String(settings[key])}
        onChange={(value) => update(key, Number(value) as never)}
      />
    </div>
  );
  const secondsField = (key: keyof RuntimeSettings, label: string) => (
    <div className="space-y-2 text-sm">
      <Input
        label={`${label}（秒）`}
        type="number"
        value={String(Number(settings[key]) / 1_000)}
        onChange={(value) => update(key, (Number(value) * 1_000) as never)}
      />
    </div>
  );
  const textField = (
    key: keyof RuntimeSettings,
    label: string,
    placeholder?: string,
    type = "text",
  ) => (
    <div className="space-y-2 text-sm">
      <Input
        label={label}
        type={type}
        value={String(settings[key])}
        placeholder={placeholder}
        onChange={(value) => update(key, value as never)}
      />
    </div>
  );

  return (
    <form className="space-y-6" onSubmit={save}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">运行配置保存在本机 SQLite 数据库中</p>
          <h1 className="mt-1 text-2xl font-semibold">设置</h1>
        </div>
        <Button type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </Button>
      </div>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <h2 className="mb-5 text-lg font-semibold">服务与代理入口</h2>
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            {textField("proxyToken", "Proxy Token", "", "password")}
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={saving}
            aria-label="随机重置 Proxy Token"
            onClick={() => {
              const bytes = crypto.getRandomValues(new Uint8Array(24));
              const proxyToken = `ek_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
              void persist({ ...settings, proxyToken });
            }}
          >
            随机重置
          </Button>
        </div>
      </section>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <h2 className="mb-5 text-lg font-semibold">探活与订阅</h2>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2 text-sm md:col-span-2 lg:col-span-3">
            <label className="font-medium" htmlFor="health-check-urls">
              探活 URL（每行一个）
            </label>
            <Textarea
              id="health-check-urls"
              value={settings.healthCheckUrls.join("\n")}
              onChange={(event) =>
                update(
                  "healthCheckUrls",
                  event.target.value
                    .split("\n")
                    .map((v) => v.trim())
                    .filter(Boolean),
                )
              }
            />
          </div>
          {secondsField("healthCheckIntervalMs", "探活间隔")}
          {secondsField("healthCheckJitterMs", "随机抖动")}
          {numberField("healthCheckConcurrency", "探活并发")}
          {numberField("healthCheckSuccessThreshold", "成功阈值")}
          {numberField("minimumSubscriptionNodes", "订阅最少节点")}
          {secondsField("remoteSubscriptionRefreshIntervalMs", "订阅刷新间隔")}
          {numberField("preconnectAttempts", "预连接尝试次数")}
          {secondsField("preconnectTimeoutMs", "预连接超时")}
          <div className="flex items-end pb-2">
            <Switch
              checked={settings.targetReputationEnabled}
              onCheckedChange={(value) => update("targetReputationEnabled", value)}
              label="启用目标信誉"
            />
          </div>
        </div>
      </section>
      <section className="rounded-2xl bg-card p-5 sm:p-6">
        <h2 className="mb-5 text-lg font-semibold">会话</h2>
        <div className="grid gap-5 md:grid-cols-2">
          {secondsField("sessionAbsoluteTtlMs", "绝对有效期")}
          {secondsField("sessionIdleTimeoutMs", "空闲超时")}
          {numberField("sessionMaximumActiveSessions", "最大活跃会话")}
          {numberField("sessionMaximumConcurrentConnections", "单会话最大并发")}
        </div>
      </section>
    </form>
  );
}

export function PlaygroundPage() {
  const { api, snapshot } = useConsole();
  const toast = useToast();
  const [mode, setMode] = useState("rotate");
  const [target, setTarget] = useState("https://ipinfo.io/json");
  const [node, setNode] = useState(snapshot.nodes[0]?.alias ?? snapshot.nodes[0]?.id ?? "node-id");
  const [proxyToken, setProxyToken] = useState("");
  const [result, setResult] = useState<PlaygroundResult>();
  const [requestLogs, setRequestLogs] = useState<PlaygroundLog[]>([]);
  const requestSequence = useRef(0);
  const [requesting, setRequesting] = useState(false);
  const [, setRequestError] = useState("");
  useEffect(() => {
    void api
      .get<{ proxyToken: string; proxyTokenAvailable: boolean }>("/playground/config")
      .then((config) => setProxyToken(config.proxyToken))
      .catch((error: unknown) =>
        setRequestError(error instanceof Error ? error.message : "无法读取 Proxy Token"),
      );
  }, [api]);
  const proxy = gatewayUrl(snapshot.gateway.host, snapshot.gateway.port);
  const username =
    mode === "node"
      ? `node.${encodeProxyUsernameValue(node)}`
      : mode === "rotate"
        ? "rotate"
        : `${mode}.session-demo`;
  const command = `curl --proxy ${shellQuote(proxy)} --proxy-user "${username}:${proxyToken}" ${shellQuote(target)}`;
  const examples = [
    { label: "检查出口 IP", value: "https://ipinfo.io/json" },
    { label: "访问网站", value: "https://example.com" },
    { label: "查询隧道", value: "https://httpbin.org/anything" },
    { label: "自定义请求", value: "https://" },
  ];
  const copyCommand = async () => {
    await navigator.clipboard?.writeText(command);
    toast({ message: "curl 命令已复制", variant: "success" });
  };
  const execute = async (event: FormEvent) => {
    event.preventDefault();
    if (requesting) return;
    setRequesting(true);
    setRequestError("");
    const requestSnapshot = {
      id: `${Date.now()}-${requestSequence.current++}`,
      mode,
      ...(mode === "node" ? { node } : {}),
      requestedAt: new Date().toISOString(),
      target,
    };
    try {
      const nextResult = await api.send<PlaygroundResult>("/playground/execute", "POST", {
        mode,
        ...(mode === "node" ? { node } : {}),
        target,
      });
      setResult(nextResult);
      setRequestLogs((logs) => [{ ...requestSnapshot, result: nextResult }, ...logs].slice(0, 20));
      toast({
        message: nextResult.status < 400 ? "请求成功" : `请求返回 HTTP ${nextResult.status}`,
        variant: nextResult.status < 400 ? "success" : "error",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求执行失败";
      setResult(undefined);
      setRequestError(message);
      setRequestLogs((logs) => [{ ...requestSnapshot, error: message }, ...logs].slice(0, 20));
      toast({ message, variant: "error" });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardContent className="pt-6">
          <form className="space-y-4" onSubmit={execute}>
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
                <button
                  type="button"
                  className="h-9 cursor-pointer rounded-xl border border-border bg-card px-3 text-left text-xs font-medium text-foreground hover:border-foreground/20"
                  key={example.label}
                  onClick={() => setTarget(example.value)}
                >
                  {example.label}
                </button>
              ))}
            </div>
            <Button
              className="w-full"
              type="submit"
              hoverScale={1}
              pressScale={1}
              disabled={!target}
              loading={requesting}
            >
              发起请求
            </Button>
          </form>
          <div className="mt-6 border-border border-t pt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">请求日志</h2>
              <span className="text-xs text-muted-foreground">最近 {requestLogs.length} 条</span>
            </div>
            <div className="max-h-[40vh] divide-y divide-border overflow-auto">
              {requestLogs.map((log) => (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center justify-between gap-3 py-3 text-left first:pt-0 last:pb-0 hover:text-foreground"
                  key={log.id}
                  onClick={() => {
                    setMode(log.mode);
                    setTarget(log.target);
                    if (log.node) setNode(log.node);
                    setResult(log.result);
                    setRequestError(log.error ?? "");
                  }}
                >
                  <span className="min-w-0">
                    <strong className="block truncate text-sm">{log.target}</strong>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {log.mode}
                      {log.result ? ` · HTTP ${log.result.status}` : ""} ·{" "}
                      {new Date(log.requestedAt).toLocaleTimeString()}
                    </span>
                  </span>
                  <StatusBadge
                    value={
                      log.error || !log.result || log.result.status >= 400 ? "failed" : "succeeded"
                    }
                  />
                </button>
              ))}
              {requestLogs.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">暂无请求记录</p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>curl 示例</h2>
          </CardTitle>
          <CardAction>
            <Tooltip content="复制 curl 命令">
              <Button
                variant="ghost"
                size="icon"
                aria-label="复制请求命令"
                onClick={() => void copyCommand()}
              >
                <Copy size={18} />
              </Button>
            </Tooltip>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="space-y-5">
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground p-4 text-sm leading-6 text-background">
              <code>{command}</code>
            </pre>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">请求结果</h2>
              {result ? <StatusBadge value={result.status < 400 ? "succeeded" : "failed"} /> : null}
            </div>
            {result ? (
              <div className="space-y-3">
                <div className="flex gap-4 text-sm">
                  <span>HTTP {result.status}</span>
                  <span className="text-muted-foreground">{result.durationMs}ms</span>
                </div>
                <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground p-4 text-sm leading-6 text-background">
                  <code>{result.body || "（空响应）"}</code>
                </pre>
              </div>
            ) : (
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground p-4 text-sm leading-6 text-background/60">
                <code>在左侧发起请求后，响应会显示在这里。</code>
              </pre>
            )}
          </div>
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
  toast: (input: { message: string; variant: "error" | "success" }) => void,
  refresh: () => Promise<void>,
): Promise<boolean> {
  try {
    const operation = await pollOperation(api, operationId, () => undefined);
    if (operation.status === "failed") {
      toast({
        message: `任务失败（${operation.failure?.stage ?? "unknown"}）：${operation.failure?.reason ?? "请重试"}`,
        variant: "error",
      });
      return false;
    }
    if (operation.status === "interrupted") {
      toast({ message: "任务因服务重启被中断，可重新刷新订阅", variant: "error" });
      return false;
    }
    toast({ message: "订阅任务已完成", variant: "success" });
    await refresh();
    return true;
  } catch (error) {
    toast({
      message: error instanceof Error ? error.message : "无法读取任务进度，请重试",
      variant: "error",
    });
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nodeDisplayName(id: string): string {
  const separator = id.indexOf(":");
  return separator === -1 ? id : id.slice(separator + 1);
}

function encodeProxyUsernameValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
