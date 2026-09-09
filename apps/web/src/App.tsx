import {
  BookOpenText,
  CirclesThreePlus,
  Gauge,
  List,
  PlugsConnected,
  TerminalWindow,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  type ApiClient,
  ApiError,
  type ConsoleSnapshot,
  consoleSnapshotPath,
  createApiClient,
} from "./api";
import { navigation, type PageId } from "./app-model";
import {
  DocsPage,
  OverviewPage,
  PlaygroundPage,
  ProxiesPage,
  SessionsPage,
  SubscriptionsPage,
} from "./pages";

const tokenKey = "egresskit-admin-token";
const icons = {
  docs: BookOpenText,
  overview: Gauge,
  playground: TerminalWindow,
  proxies: PlugsConnected,
  sessions: UsersThree,
  subscriptions: CirclesThreePlus,
} satisfies Record<PageId, typeof Gauge>;

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
        <Route index element={<OverviewPage />} />
        <Route path="subscriptions" element={<SubscriptionsPage />} />
        <Route path="proxies" element={<ProxiesPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="docs" element={<DocsPage />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/app" />} />
    </Routes>
  );
}

function ConsoleLayout({ onUnauthorized, token }: { onUnauthorized(): void; token: string }) {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
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
      setConnectionSamples((samples) => [
        ...samples.slice(-11),
        {
          at: next.generatedAt,
          value: next.metrics.successConnections + next.metrics.failedConnections,
        },
      ]);
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

  useEffect(() => {
    if (!mobileOpen) return;
    drawerCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  const trapDrawerFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [
      ...(drawerRef.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!token) {
    return <Navigate replace state={{ from: location.pathname }} to="/app/connect" />;
  }

  return (
    <ConsoleContext.Provider
      value={snapshot ? { api, connectionSamples, refresh, snapshot } : undefined}
    >
      <div className="min-h-screen bg-[#f2f3f1] text-[#111412]">
        <button
          className="fixed left-4 top-4 z-40 grid size-11 place-items-center rounded-xl bg-[#202321] text-white shadow-lg lg:hidden"
          type="button"
          aria-label="打开导航"
          onClick={() => setMobileOpen(true)}
        >
          <List size={22} />
        </button>
        {mobileOpen ? (
          <button
            className="fixed inset-0 z-40 bg-black/25 lg:hidden"
            type="button"
            aria-label="关闭导航遮罩"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        {mobileOpen ? (
          <aside
            ref={drawerRef}
            role="dialog"
            aria-label="移动导航"
            aria-modal="true"
            className="fixed bottom-0 left-0 top-0 z-50 flex w-64 flex-col items-stretch rounded-r-[28px] bg-[#202321] p-4 shadow-[0_18px_46px_rgba(17,20,18,.22)] lg:hidden"
            onKeyDown={trapDrawerFocus}
          >
            <button
              ref={drawerCloseRef}
              type="button"
              className="mb-2 grid size-10 place-items-center rounded-xl text-white/70 lg:hidden"
              aria-label="关闭导航"
              onClick={() => setMobileOpen(false)}
            >
              <X size={20} />
            </button>
            <img className="mb-6 size-11 lg:mb-3" src="/brand/egresskit-mark.svg" alt="EgressKit" />
            <NavigationLinks mobile onNavigate={() => setMobileOpen(false)} />
          </aside>
        ) : null}
        <aside className="fixed left-6 top-1/2 z-50 hidden -translate-y-1/2 flex-col items-center rounded-[28px] bg-[#202321] p-2.5 shadow-[0_18px_46px_rgba(17,20,18,.22)] lg:flex">
          <img className="mb-3 size-11" src="/brand/egresskit-mark.svg" alt="EgressKit" />
          <NavigationLinks onNavigate={() => undefined} />
        </aside>
        <main className="mx-auto min-h-screen max-w-[1520px] px-5 py-8 sm:px-8 lg:px-12 lg:pl-32 lg:py-12">
          {error && !snapshot ? (
            <section className="mx-auto mt-24 max-w-lg rounded-2xl border border-red-200 bg-white p-8 text-center">
              <h1 className="text-xl font-semibold">控制台数据加载失败</h1>
              <p className="mt-2 text-sm text-[#66706a]">{error}</p>
              <button className="btn-primary mt-6" type="button" onClick={() => void refresh()}>
                重新加载
              </button>
            </section>
          ) : snapshot ? (
            <>
              {error ? (
                <div
                  className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                  role="alert"
                >
                  <span>{error}</span>
                  <button type="button" className="font-semibold" onClick={() => void refresh()}>
                    重试
                  </button>
                </div>
              ) : null}
              <Outlet />
            </>
          ) : (
            <div className="animate-pulse pt-12" aria-label="正在读取控制台" role="status">
              <div className="h-12 w-56 rounded-xl bg-black/8" />
              <div className="mt-5 h-5 w-80 max-w-full rounded-lg bg-black/6" />
              <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((item) => (
                  <div className="h-36 rounded-2xl bg-white" key={item} />
                ))}
              </div>
              <div className="mt-5 h-72 rounded-2xl bg-white" />
            </div>
          )}
        </main>
      </div>
    </ConsoleContext.Provider>
  );
}

function NavigationLinks({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate(): void }) {
  return (
    <nav className="flex flex-col gap-1.5" aria-label="主要导航">
      {navigation.map((item) => {
        const Icon = icons[item.id];
        return (
          <NavLink
            key={item.id}
            aria-label={item.label}
            end={item.id === "overview"}
            title={item.label}
            to={item.path}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group relative flex h-12 items-center rounded-2xl px-3 transition ${mobile ? "" : "size-12 justify-center px-0"} ${
                isActive
                  ? "bg-[#ff5538] text-white shadow-[0_9px_22px_rgba(255,85,56,.34)]"
                  : "text-white/70 hover:bg-white/8 hover:text-white"
              }`
            }
          >
            <Icon size={23} />
            {mobile ? <span className="ml-3 text-sm font-medium">{item.label}</span> : null}
            {!mobile ? (
              <span className="pointer-events-none absolute left-[58px] hidden whitespace-nowrap rounded-lg bg-[#111412] px-2.5 py-1.5 text-xs text-white shadow-lg group-hover:block group-focus-visible:block">
                {item.label}
              </span>
            ) : null}
          </NavLink>
        );
      })}
    </nav>
  );
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
    <main className="grid min-h-screen place-items-center bg-[#f2f3f1] px-5 py-10 text-[#111412]">
      <section className="w-full max-w-md rounded-[28px] border border-black/6 bg-white p-7 shadow-[0_24px_80px_rgba(17,20,18,.08)] sm:p-10">
        <img className="h-10 w-auto" src="/brand/egresskit-logo.svg" alt="EgressKit" />
        <p className="mt-12 text-xs font-semibold uppercase tracking-[.2em] text-[#ff5538]">
          Token access
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-.04em]">连接控制台</h1>
        <p className="mt-3 text-sm leading-6 text-[#66706a]">
          输入实例的 Admin Token。凭据仅保存在当前浏览器会话中。
        </p>
        <form className="mt-8" onSubmit={submit}>
          <label className="text-sm font-medium" htmlFor="admin-token">
            Admin Token
          </label>
          <input
            className="mt-2 w-full rounded-xl border border-black/10 bg-[#f7f7f5] px-4 py-3 outline-none transition focus:border-[#ff5538] focus:ring-4 focus:ring-[#ff5538]/10"
            id="admin-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="输入 Admin Token"
            required
          />
          {error ? (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <button className="btn-primary mt-5 w-full" type="submit" disabled={loading || !token}>
            {loading ? "正在验证…" : "连接"}
          </button>
        </form>
      </section>
    </main>
  );
}
