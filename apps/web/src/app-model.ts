export type PageId =
  | "docs"
  | "overview"
  | "playground"
  | "proxies"
  | "sessions"
  | "settings"
  | "subscriptions";

export const navigation: readonly { id: PageId; label: string; path: string }[] = [
  { id: "overview", label: "运行概览", path: "/app" },
  { id: "subscriptions", label: "订阅管理", path: "/app/subscriptions" },
  { id: "proxies", label: "代理管理", path: "/app/proxies" },
  { id: "sessions", label: "活跃会话", path: "/app/sessions" },
  { id: "playground", label: "快速操作", path: "/app/playground" },
  { id: "settings", label: "设置", path: "/app/settings" },
  { id: "docs", label: "使用文档", path: "/app/docs" },
];
