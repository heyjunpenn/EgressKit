import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "../motion/button/base";

type ToastVariant = "error" | "success";
interface ToastInput {
  message: string;
  variant: ToastVariant;
}
interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<((input: ToastInput) => void) | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { ...input, id }].slice(-4));
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4_000);
  }, []);
  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed top-5 right-5 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {items.map((item) => {
          const Icon = item.variant === "success" ? CheckCircle : WarningCircle;
          return (
            <div
              key={item.id}
              role={item.variant === "error" ? "alert" : "status"}
              className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm shadow-lg"
            >
              <Icon
                className={item.variant === "error" ? "text-destructive" : "text-emerald-600"}
                size={19}
                weight="fill"
              />
              <span className="min-w-0 flex-1 break-words">{item.message}</span>
              <Button
                aria-label="关闭通知"
                className="h-7 w-7"
                size="icon"
                variant="ghost"
                onClick={() => setItems((current) => current.filter(({ id }) => id !== item.id))}
              >
                <X size={14} />
              </Button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("toast context is unavailable");
  return toast;
}
