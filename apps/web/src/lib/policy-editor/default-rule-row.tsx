"use client";

import { ShieldBan, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { TableCell, TableRow } from "@onecli/ui/components/table";
import { cn } from "@onecli/ui/lib/utils";
import { useSetPolicyDefault } from "@/hooks/use-policy";
import type { PageScope, PolicyRuleV2 } from "@/lib/api";

export interface DefaultRuleRowProps {
  scope: PageScope;
  rule: PolicyRuleV2;
  /** Editable scope shows an Allowed/Blocked toggle; guardrails show a verdict. */
  editable: boolean;
  /** Staged-change chip: the default's action differs from the published one. */
  changed?: boolean;
}

/**
 * The terminal Default Rule as an ordinary row (same plain background as the
 * rest) — it's the last thing checked in its section. Its action cell is an
 * inline Allowed/Blocked toggle when editable, staged like any other edit.
 */
export const DefaultRuleRow = ({
  scope,
  rule,
  editable,
  changed = false,
}: DefaultRuleRowProps) => {
  const setDefault = useSetPolicyDefault(scope);
  const set = (action: "allow" | "block") => {
    if (action !== rule.action) setDefault.mutate(action);
  };
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="text-muted-foreground pl-4 text-[11px] font-medium tracking-wide uppercase">
        Default
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-sm font-medium">Default Rule</span>
          {changed && (
            <Badge
              variant="outline"
              className="rounded border-amber-500/40 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
            >
              Changed
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
          <Users className="size-3.5 shrink-0" aria-hidden />
          All agents
        </span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground text-xs">Any</span>
      </TableCell>
      <TableCell>
        {editable ? (
          <div
            role="group"
            aria-label="Default action"
            className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
          >
            <DefaultOption
              selected={rule.action === "allow"}
              disabled={setDefault.isPending}
              onClick={() => set("allow")}
              icon={
                <ShieldCheck
                  className="size-3.5 text-emerald-700 dark:text-emerald-400"
                  aria-hidden
                />
              }
              label="Allowed"
              tone="emerald"
            />
            <DefaultOption
              selected={rule.action === "block"}
              disabled={setDefault.isPending}
              onClick={() => set("block")}
              icon={
                <ShieldBan className="size-3.5 text-destructive" aria-hidden />
              }
              label="Blocked"
              tone="destructive"
            />
          </div>
        ) : rule.action === "block" ? (
          <span className="text-destructive inline-flex items-center gap-1.5 text-xs font-medium">
            <ShieldBan className="size-3.5" aria-hidden />
            Block
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <ShieldCheck className="size-3.5" aria-hidden />
            Allow
          </span>
        )}
      </TableCell>
      <TableCell />
    </TableRow>
  );
};

interface DefaultOptionProps {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone: "emerald" | "destructive";
}

const DefaultOption = ({
  selected,
  disabled,
  onClick,
  icon,
  label,
  tone,
}: DefaultOptionProps) => (
  <button
    type="button"
    aria-pressed={selected}
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 disabled:opacity-60",
      selected
        ? tone === "emerald"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-destructive/10 text-destructive"
        : "text-muted-foreground hover:text-foreground",
    )}
  >
    {icon}
    {label}
  </button>
);
