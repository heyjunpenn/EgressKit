import {
  BookOpenText,
  CirclesThreePlus,
  Gauge,
  PlugsConnected,
  TerminalWindow,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/motion/select";
import { Tabs, TabsList, TabsTrigger } from "./components/motion/tabs";
import { Card, CardContent } from "./components/ui/card";
import {
  OverviewPage,
  PlaygroundPage,
  ProxiesPage,
  SessionsPage,
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
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey) ?? "");
  const authenticate = (nextToken: string) => {
    sessionStorage.setItem(tokenKey, nextToken);
    setToken(nextToken);
  };
  const clearAuthentication = useCallback(() => {
    sessionStorage.removeItem(tokenKey);
    setToken("");
  }, []);

  return (
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
        <AppHeader activeId={activePage.id} />
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

function AppHeader({ activeId }: { activeId: PageId }) {
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
      <div className="mx-auto grid max-w-[1480px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6 lg:grid-cols-[11rem_minmax(0,1fr)_11rem] lg:gap-y-0 md:px-8">
        <Link
          to="/app"
          aria-label="EgressKit"
          className="w-fit rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <img
            src="/brand/egresskit-logo.svg"
            alt=""
            width="400"
            height="64"
            className="h-7 w-auto"
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

        <Select value={language} onValueChange={setLanguage} className="w-28 justify-self-end">
          <SelectTrigger ariaLabel="界面语言 / Language" className="bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/app";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await createApiClient(token).get<ConsoleSnapshot>(consoleSnapshotPath);
      onAuthenticated(token);
      navigate(from, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法验证 Admin Token");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background px-5 py-10 text-foreground">
      <Card className="w-full max-w-md">
        <CardContent>
          <img className="h-10 w-auto" src="/brand/egresskit-logo.svg" alt="EgressKit" />
          <h1 className="sr-only">连接控制台</h1>
          <form className="mt-8 space-y-5" onSubmit={submit}>
            <Input
              id="admin-token"
              aria-label="Admin Token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={setToken}
              placeholder="输入 Admin Token"
              error={error || undefined}
              reserveErrorLine
              required
            />
            <Button className="w-full" type="submit" disabled={loading || !token}>
              {loading ? "正在验证…" : "连接"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
