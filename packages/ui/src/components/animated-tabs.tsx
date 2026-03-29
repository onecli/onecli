"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@onecli/ui/lib/utils";

// ── Context ──────────────────────────────────────────────────────────────

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (id: string) => void;
  registerTab: (id: string) => (el: HTMLButtonElement | null) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const useTabsContext = () => {
  const ctx = useContext(TabsContext);
  if (!ctx)
    throw new Error(
      "AnimatedTabs compound components must be used within <AnimatedTabs>",
    );
  return ctx;
};

// ── Root ─────────────────────────────────────────────────────────────────

interface AnimatedTabsProps {
  defaultValue: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string;
}

export const AnimatedTabs = ({
  defaultValue,
  onValueChange,
  children,
  className,
}: AnimatedTabsProps) => {
  const [activeTab, setActiveTabState] = useState(defaultValue);
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  const setActiveTab = useCallback(
    (id: string) => {
      setActiveTabState(id);
      onValueChange?.(id);
    },
    [onValueChange],
  );

  const registerTab = useCallback(
    (id: string) => (el: HTMLButtonElement | null) => {
      if (el) tabsRef.current.set(id, el);
      else tabsRef.current.delete(id);
    },
    [],
  );

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab, registerTab }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
};

// ── Tab List ─────────────────────────────────────────────────────────────

interface AnimatedTabListProps {
  children: ReactNode;
  className?: string;
}

export const AnimatedTabList = ({
  children,
  className,
}: AnimatedTabListProps) => {
  const { activeTab } = useTabsContext();
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const barRef = useRef<HTMLDivElement>(null);

  const updateIndicator = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const active = bar.querySelector<HTMLButtonElement>(
      `[data-tab-active="true"]`,
    );
    if (!active) return;
    const barRect = bar.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    setIndicator({
      left: tabRect.left - barRect.left,
      width: tabRect.width,
    });
  }, []);

  useEffect(() => {
    updateIndicator();
  }, [activeTab, updateIndicator]);

  useEffect(() => {
    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [updateIndicator]);

  return (
    <div
      ref={barRef}
      className={cn("relative flex items-center border-b", className)}
    >
      {children}
      <span
        className="absolute -bottom-[1.5px] h-0.5 bg-foreground rounded-full transition-all duration-300 ease-out"
        style={{ left: indicator.left, width: indicator.width }}
      />
    </div>
  );
};

// ── Tab Trigger ──────────────────────────────────────────────────────────

interface AnimatedTabTriggerProps {
  value: string;
  children: ReactNode;
  className?: string;
}

export const AnimatedTabTrigger = ({
  value,
  children,
  className,
}: AnimatedTabTriggerProps) => {
  const { activeTab, setActiveTab, registerTab } = useTabsContext();
  const isActive = activeTab === value;

  return (
    <button
      ref={registerTab(value)}
      data-tab-active={isActive}
      onClick={() => setActiveTab(value)}
      className={cn(
        "px-4 py-2.5 text-sm font-medium transition-colors",
        "hover:text-foreground",
        isActive ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
};

// ── Tab Content ──────────────────────────────────────────────────────────

interface AnimatedTabContentProps {
  value: string;
  children: ReactNode;
  className?: string;
}

export const AnimatedTabContent = ({
  value,
  children,
  className,
}: AnimatedTabContentProps) => {
  const { activeTab } = useTabsContext();
  if (activeTab !== value) return null;
  return <div className={className}>{children}</div>;
};
