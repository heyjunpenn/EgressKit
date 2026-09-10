import {
  BookOpenText,
  CirclesThreePlus,
  Gauge,
  GearSix,
  PlugsConnected,
  SignOut,
  TerminalWindow,
  Translate,
  UsersThree,
} from "@phosphor-icons/react";
import {
  createContext,
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  type ApiClient,
  ApiError,
  type ConsoleSnapshot,
  consoleSnapshotPath,
  createApiClient,
} from "./api";
import { navigation, type PageId } from "./app-model";
import { Button } from "./components/motion/button/base";
import { Input } from "./components/motion/input";
import { Loader } from "./components/motion/loader";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./components/motion/select";
import { Tabs, TabsList, TabsTrigger } from "./components/motion/tabs";
import { Tooltip } from "./components/motion/tooltip";
import { Card, CardContent } from "./components/ui/card";
import { ToastProvider, useToast } from "./components/ui/toast";
import {
  OverviewPage,
  PlaygroundPage,
  ProxiesPage,
  SessionsPage,
  SettingsPage,
  SubscriptionsPage,
} from "./pages";

const DocsPage = lazy(async () => {
  const module = await import("./docs-page");
  return { default: module.DocsPage };
});

const tokenKey = "egresskit-admin-token";
const icons = {
  docs: BookOpenText,
  overview: Gauge,
  playground: TerminalWindow,
  proxies: PlugsConnected,
  sessions: UsersThree,
  settings: GearSix,
  subscriptions: CirclesThreePlus,
} satisfies Record<PageId, typeof Gauge>;
const workspaceNavigation = navigation.filter((item) => item.id !== "docs");

interface ConsoleContextValue {
  api: ApiClient;
  connectionSamples: Array<{ at: string; value: number }>;
  refresh(): Promise<void>;
  snapshot: ConsoleSnapshot;
}

const ConsoleContext = createContext<ConsoleContextValue | undefined>(undefined);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("console context is unavailable");
  return value;
}

export function App() {
  const [token, setToken] = useState(() => {
    const persisted = localStorage.getItem(tokenKey);
    if (persisted) return persisted;
    const legacy = sessionStorage.getItem(tokenKey) ?? "";
    if (legacy) localStorage.setItem(tokenKey, legacy);
    return legacy;
  });
  const authenticate = (nextToken: string) => {
    localStorage.setItem(tokenKey, nextToken);
    sessionStorage.removeItem(tokenKey);
    setToken(nextToken);
  };
  const clearAuthentication = useCallback(() => {
    localStorage.removeItem(tokenKey);
    sessionStorage.removeItem(tokenKey);
    setToken("");
  }, []);

  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Navigate replace to="/app" />} />
        <Route path="/app/connect" element={<ConnectPage onAuthenticated={authenticate} />} />
        <Route
          path="/app"
          element={<ConsoleLayout token={token} onUnauthorized={clearAuthentication} />}
        >
          <Route index element={<OverviewRoute />} />
          <Route path="subscriptions" element={<SubscriptionsPage />} />
          <Route path="proxies" element={<ProxiesPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="playground" element={<PlaygroundPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route
            path="docs"
            element={
              <Suspense fallback={<RouteLoader label="正在读取使用文档" />}>
                <DocsPage />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate replace to="/app" />} />
      </Routes>
    </ToastProvider>
  );
}

function ConsoleLayout({ onUnauthorized, token }: { onUnauthorized(): void; token: string }) {
  const location = useLocation();
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>();
  const [connectionSamples, setConnectionSamples] = useState<Array<{ at: string; value: number }>>(
    [],
  );
  const [error, setError] = useState("");
  const api = useMemo(() => createApiClient(token, fetch, onUnauthorized), [token, onUnauthorized]);
  const refresh = useCallback(async () => {
    try {
      setError("");
      const next = await api.get<ConsoleSnapshot>(consoleSnapshotPath);
      setSnapshot(next);
      setConnectionSamples((samples) => {
        const previous = samples.filter((sample) => sample.at !== next.generatedAt);
        return [
          ...previous.slice(-11),
          {
            at: next.generatedAt,
            value: next.metrics.successConnections + next.metrics.failedConnections,
          },
        ];
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onUnauthorized();
        return;
      }
      setError(cause instanceof Error ? cause.message : "控制台数据暂时不可用");
    }
  }, [api, onUnauthorized]);

  useEffect(() => {
    if (token) void refresh();
  }, [refresh, token]);

  if (!token) {
    return (
      <Navigate
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
        to="/app/connect"
      />
    );
  }

  const activePage = navigation.find((item) => item.path === location.pathname) ?? navigation[0];

  return (
    <ConsoleContext.Provider
      value={snapshot ? { api, connectionSamples, refresh, snapshot } : undefined}
    >
      <div className="min-h-[100dvh] bg-background text-foreground">
        <AppHeader activeId={activePage.id} onLogout={onUnauthorized} />
        <main
          aria-label={`${activePage.label}面板`}
          className="mx-auto max-w-[1480px] px-4 pb-12 pt-6 sm:px-6 md:px-8"
        >
          {error && !snapshot ? (
            <Card className="mx-auto mt-24 max-w-lg">
              <CardContent className="text-center">
                <h1 className="text-xl font-semibold">控制台数据加载失败</h1>
                <p className="mt-2 text-sm text-muted-foreground">{error}</p>
                <Button className="mt-6" onClick={() => void refresh()}>
                  重新加载
                </Button>
              </CardContent>
            </Card>
          ) : snapshot ? (
            <>
              {error ? (
                <Card className="mb-4 border-destructive/30">
                  <CardContent
                    className="flex items-center justify-between gap-4 text-sm text-destructive"
                    role="alert"
                  >
                    <span>{error}</span>
                    <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                      重试
                    </Button>
                  </CardContent>
                </Card>
              ) : null}
              <Outlet />
            </>
          ) : (
            <div className="grid min-h-[70dvh] place-items-center">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader size={24} label="正在读取控制台" />
                正在读取控制台
              </div>
            </div>
          )}
        </main>
      </div>
    </ConsoleContext.Provider>
  );
}

function AppHeader({ activeId, onLogout }: { activeId: PageId; onLogout(): void }) {
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const [language, setLanguage] = useState("zh-CN");

  useEffect(() => {
    const activeItem = listRef.current?.querySelector<HTMLElement>(`[data-value="${activeId}"]`);
    if (typeof activeItem?.scrollIntoView === "function") {
      activeItem.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
    }
  }, [activeId]);

  return (
    <header className="sticky top-0 z-50 bg-background">
      <div className="mx-auto grid max-w-[1480px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-4 pb-4 pt-6 sm:px-6 lg:grid-cols-[11rem_minmax(0,1fr)_11rem] lg:gap-y-0 md:px-8">
        <Link
          to="/app"
          aria-label="EgressKit"
          className="w-fit rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <img
            src="/brand/egresskit-logo.svg"
            alt=""
            width="2162"
            height="535"
            className="h-8 w-auto"
          />
        </Link>

        <nav
          aria-label="主要导航"
          className="scrollbar-hide -my-2 col-span-2 row-start-2 overflow-x-auto py-2 lg:col-span-1 lg:col-start-2 lg:row-start-1"
          ref={listRef}
        >
          <Tabs
            value={activeId}
            onValueChange={(id) => {
              const destination = navigation.find((item) => item.id === id);
              if (destination) navigate(destination.path);
            }}
            variant="pill"
            semantics="navigation"
            className="w-max lg:mx-auto"
          >
            <TabsList className="min-w-max shadow-md">
              {navigation.map((item) => {
                const Icon = icons[item.id];
                const active = item.id === activeId;
                if (item.id === "docs") {
                  return (
                    <a
                      key={item.id}
                      href="https://github.com/heyjunpenn/EgressKit#readme"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="relative z-10 inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/60"
                    >
                      <Icon aria-hidden size={16} />
                      <span>{item.label}</span>
                    </a>
                  );
                }
                return (
                  <TabsTrigger key={item.id} value={item.id} className="gap-1.5 px-3">
                    <Icon aria-hidden size={16} weight={active ? "fill" : "regular"} />
                    <span>{item.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </nav>

        <div className="flex items-center justify-self-end gap-1">
          <Select value={language} onValueChange={setLanguage} className="w-9">
            <SelectTrigger
              ariaLabel="界面语言 / Language"
              className="h-9 justify-center border-0 bg-transparent p-0 hover:bg-card [&>span:last-child]:hidden"
            >
              <Translate aria-hidden size={18} />
            </SelectTrigger>
            <SelectContent className="left-auto right-0 min-w-max whitespace-nowrap">
              <SelectItem value="zh-CN">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <Tooltip content="退出登录" side="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              onClick={() => {
                onLogout();
                navigate("/app/connect", { replace: true });
              }}
            >
              <SignOut aria-hidden size={18} weight="fill" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

function RouteLoader({ label }: { label: string }) {
  return (
    <div className="grid min-h-[45dvh] place-items-center">
      <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
        <Loader size={24} label={label} />
        {label}
      </div>
    </div>
  );
}

function OverviewRoute() {
  const location = useLocation();
  const hashId = location.hash.slice(1) as PageId;
  const destination = workspaceNavigation.find((item) => item.id === hashId);

  if (location.hash) {
    return <Navigate replace to={destination?.path ?? "/app"} />;
  }

  return <OverviewPage />;
}

function ConnectPage({ onAuthenticated }: { onAuthenticated(token: string): void }) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/app";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      await createApiClient(token).get<ConsoleSnapshot>(consoleSnapshotPath);
      onAuthenticated(token);
      navigate(from, { replace: true });
    } catch (cause) {
      toast({
        message: cause instanceof Error ? cause.message : "无法验证 Admin Token",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-background px-5 py-8 text-foreground sm:px-8 lg:grid lg:place-items-center lg:py-12">
      <div className="mx-auto grid w-full max-w-6xl overflow-hidden rounded-2xl border border-foreground/10 bg-foreground shadow-[0_20px_50px_oklch(15%_0_0/0.12)] lg:grid-cols-[1.15fr_0.85fr]">
        <section
          aria-label="EgressKit 简介"
          className="flex min-h-[25rem] flex-col justify-between gap-12 px-7 py-8 text-background sm:px-10 sm:py-10 lg:min-h-[38rem] lg:px-14 lg:py-12"
        >
          <img
            className="h-8 w-auto self-start"
            src="/brand/egresskit-logo-inverse.svg"
            alt="EgressKit"
          />
          <svg
            role="img"
            aria-label="EgressKit 代理路由示意图"
            viewBox="0 0 560 230"
            className="w-full max-w-xl self-center"
          >
            <path
              d="M154 115H244M316 115H406M280 79V44M280 151V186"
              stroke="currentColor"
              strokeWidth="2"
              opacity=".28"
            />
            <rect x="244" y="79" width="72" height="72" rx="16" fill="currentColor" opacity=".12" />
            <circle cx="280" cy="115" r="11" fill="currentColor" />
            <rect
              x="36"
              y="78"
              width="118"
              height="74"
              rx="14"
              fill="none"
              stroke="#36cf88"
              strokeWidth="2"
            />
            <path d="M65 105h60M65 125h38" stroke="#36cf88" strokeWidth="5" strokeLinecap="round" />
            <circle cx="440" cy="58" r="29" fill="#ffbf38" />
            <circle cx="471" cy="115" r="29" fill="#ffbf38" />
            <circle cx="440" cy="172" r="29" fill="#ffbf38" />
            <path
              d="M316 109l97-45M316 115h126M316 121l97 45"
              stroke="currentColor"
              strokeWidth="2"
              opacity=".28"
            />
          </svg>
          <div className="max-w-xl">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
              Clash/Vless -&gt; Http Proxy
            </h2>
            <p className="mt-4 max-w-[58ch] text-pretty text-sm leading-6 text-background/68 sm:text-base sm:leading-7">
              EgressKit 将多个 Clash / VLESS 节点聚合为稳定的 HTTP
              代理入口，统一处理订阅更新、节点探活、会话粘连与出口轮换。
            </p>
          </div>
        </section>

        <section
          aria-label="连接表单"
          className="flex items-center bg-card px-7 py-12 sm:px-10 lg:px-14"
        >
          <div className="w-full">
            <p className="text-sm text-muted-foreground">管理控制台</p>
            <h1 className="mt-2 text-2xl font-semibold">连接控制台</h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
              输入后端启动时配置的 Admin Token。
            </p>
            <form className="mt-8 space-y-5" onSubmit={submit}>
              <Input
                id="admin-token"
                aria-label="Admin Token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={setToken}
                placeholder="输入 Admin Token"
                required
              />
              <Button className="w-full" type="submit" disabled={!token} loading={loading}>
                连接
              </Button>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
