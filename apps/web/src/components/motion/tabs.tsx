"use client";
// beui.dev/components/motion/tabs

import { MotionConfig, motion, type Transition, useReducedMotion } from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

type Variant = "pill" | "underline" | "segment";
type Semantics = "navigation" | "tabs";

type Ctx = {
  value: string;
  setValue: (v: string) => void;
  layoutId: string;
  variant: Variant;
  semantics: Semantics;
};

const TabsCtx = createContext<Ctx | null>(null);

function useTabs() {
  const ctx = useContext(TabsCtx);
  if (!ctx) throw new Error("Tabs.* must be used inside <Tabs>");
  return ctx;
}

// Weighty spring for the active-tab indicator: a touch of overshoot so it
// settles with life instead of snapping.
const transition: Transition = {
  duration: 0.2,
  ease: EASE_OUT,
};

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  variant = "pill",
  semantics = "tabs",
  children,
  className,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  variant?: Variant;
  semantics?: Semantics;
  children: ReactNode;
  className?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const layoutId = useId();
  const reduce = useReducedMotion();
  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const setValue = useCallback(
    (v: string) => {
      if (!controlled) setInternal(v);
      onValueChange?.(v);
    },
    [controlled, onValueChange],
  );
  const contextValue = useMemo(
    () => ({ value: current, setValue, layoutId, variant, semantics }),
    [current, layoutId, semantics, setValue, variant],
  );
  return (
    <MotionConfig transition={reduce ? { duration: 0 } : transition}>
      <TabsCtx.Provider value={contextValue}>
        {/* layoutRoot: the indicator's layoutId measures in page coordinates, so
            inside fixed/scrolled containers it would replay scroll offsets as
            movement. The pill only ever travels within the list, so scoping
            projection to the Tabs wrapper is always correct. */}
        <motion.div layoutRoot className={className}>
          {children}
        </motion.div>
      </TabsCtx.Provider>
    </MotionConfig>
  );
}

const listClasses: Record<Variant, string> = {
  pill: "inline-flex items-center gap-1 rounded-full bg-card p-1",
  underline: "inline-flex items-center gap-1 border-b border-border",
  segment: "inline-flex items-center gap-0 rounded-lg bg-card p-0.5",
};

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const { semantics, variant } = useTabs();
  return (
    <div
      role={semantics === "tabs" ? "tablist" : undefined}
      className={cn(listClasses[variant], className)}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
  indicatorClassName,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  indicatorClassName?: string;
}) {
  const { value: current, setValue, layoutId, semantics, variant } = useTabs();
  const active = current === value;
  const semanticsProps =
    semantics === "tabs"
      ? ({ role: "tab", "aria-selected": active } as const)
      : ({ "aria-current": active ? "page" : undefined } as const);

  if (variant === "underline") {
    return (
      <button
        type="button"
        {...semanticsProps}
        onClick={() => setValue(value)}
        className={cn(
          "relative isolate -mb-px inline-flex min-h-[44px] cursor-pointer items-center px-3 pt-1 pb-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        {children}
        {active ? (
          <motion.span
            layoutId={layoutId}
            layout="position"
            className={cn("absolute -bottom-px left-0 right-0 h-px bg-primary", indicatorClassName)}
          />
        ) : null}
      </button>
    );
  }

  const radius = variant === "pill" ? "rounded-full" : "rounded-md";

  return (
    <div className="relative">
      {active ? (
        <motion.span
          layoutId={layoutId}
          layout="position"
          style={{ borderRadius: variant === "pill" ? 9999 : 8 }}
          className={cn("absolute inset-0 bg-primary", radius, indicatorClassName)}
        />
      ) : null}
      <button
        type="button"
        {...semanticsProps}
        onClick={() => setValue(value)}
        data-value={value}
        className={cn(
          "relative z-10 inline-flex cursor-pointer items-center justify-center whitespace-nowrap bg-transparent px-3.5 py-1.5 text-sm font-medium outline-none [@media(pointer:coarse)]:min-h-11",
          "focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "transition-colors",
          active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          radius,
          className,
        )}
      >
        {children}
      </button>
    </div>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const { value: current } = useTabs();
  const reduce = useReducedMotion();
  const active = current === value;
  // Inactive panels stay mounted but hidden, so their content (e.g. source
  // code) is present in the server-rendered HTML for crawlers and assistive
  // tech, instead of being dropped from the DOM.
  if (!active) {
    return (
      <div hidden className={className}>
        {children}
      </div>
    );
  }
  return (
    <motion.div
      key={value}
      initial={{ opacity: 0, y: reduce ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: EASE_OUT }}
      className={cn("mt-4", className)}
    >
      {children}
    </motion.div>
  );
}
