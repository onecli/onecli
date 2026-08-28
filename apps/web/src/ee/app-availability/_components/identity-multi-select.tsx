"use client";

import { useMemo, useState } from "react";
import { Plus, UserRound, Users, X } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Input } from "@onecli/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import { useGroups } from "@/hooks/use-groups";
import { useOrgMembersList } from "@/hooks/use-org-members";

interface Option {
  kind: "user" | "group";
  id: string;
  label: string;
  sub?: string;
}

const SECTIONS: {
  kind: "user" | "group";
  title: string;
  Icon: typeof Users;
}[] = [
  { kind: "group", title: "User groups", Icon: Users },
  { kind: "user", title: "Users", Icon: UserRound },
];

export interface IdentityMultiSelectProps {
  userIds: string[];
  groupIds: string[];
  onChange: (userIds: string[], groupIds: string[]) => void;
  disabled?: boolean;
}

/**
 * A combined multi-select over the org directory — the users AND user-groups a
 * rule applies to. Selections show as removable chips; the popover is a
 * searchable checkbox list grouped by kind. Only the org's own directory is
 * offered (the reads are admin-gated).
 */
export const IdentityMultiSelect = ({
  userIds,
  groupIds,
  onChange,
  disabled,
}: IdentityMultiSelectProps) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: groups = [] } = useGroups();
  const { data: members = [] } = useOrgMembersList(true);

  const options = useMemo<Option[]>(
    () => [
      ...groups.map((g) => ({
        kind: "group" as const,
        id: g.id,
        label: g.name,
        sub: `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`,
      })),
      ...members
        // Mirror the backend's ownership check (`status: { not: "suspended" }`):
        // a suspended member isn't a valid principal, so naming one would wedge
        // the whole save. Non-suspended (active + invited) stay selectable.
        .filter(
          (m) =>
            m.status !== "suspended" && !m.email.endsWith("@onecli.internal"),
        )
        .map((m) => ({
          kind: "user" as const,
          id: m.userId,
          label: m.name ?? m.email,
          sub: m.name ? m.email : undefined,
        })),
    ],
    [groups, members],
  );

  const userSet = useMemo(() => new Set(userIds), [userIds]);
  const groupSet = useMemo(() => new Set(groupIds), [groupIds]);
  const isSelected = (o: Option) =>
    o.kind === "user" ? userSet.has(o.id) : groupSet.has(o.id);

  const toggle = (o: Option) => {
    if (o.kind === "user") {
      onChange(
        userSet.has(o.id)
          ? userIds.filter((id) => id !== o.id)
          : [...userIds, o.id],
        groupIds,
      );
    } else {
      onChange(
        userIds,
        groupSet.has(o.id)
          ? groupIds.filter((id) => id !== o.id)
          : [...groupIds, o.id],
      );
    }
  };

  const labelFor = (kind: "user" | "group", id: string) =>
    options.find((o) => o.kind === kind && o.id === id)?.label ?? id;

  const selected: Option[] = [
    ...groupIds.map((id) => ({
      kind: "group" as const,
      id,
      label: labelFor("group", id),
    })),
    ...userIds.map((id) => ({
      kind: "user" as const,
      id,
      label: labelFor("user", id),
    })),
  ];

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          o.sub?.toLowerCase().includes(needle),
      )
    : options;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {selected.map((o) => {
        const Icon = o.kind === "group" ? Users : UserRound;
        return (
          <Badge
            key={`${o.kind}:${o.id}`}
            variant="secondary"
            className="gap-1 rounded-md py-1 pr-1 pl-2 font-normal"
          >
            <Icon className="size-3 shrink-0" aria-hidden />
            <span className="max-w-[140px] truncate">{o.label}</span>
            <button
              type="button"
              onClick={() => toggle(o)}
              disabled={disabled}
              className="hover:bg-background/60 ml-0.5 rounded-sm p-0.5 disabled:opacity-50"
              aria-label={`Remove ${o.label}`}
            >
              <X className="size-3" aria-hidden />
            </button>
          </Badge>
        );
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* A dashed "add token" pill — light + proportionate to the chips it
              sits beside, not a heavy solid CTA. */}
          <button
            type="button"
            disabled={disabled}
            className="text-muted-foreground hover:border-foreground/30 hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <Plus className="size-3.5" aria-hidden />
            Add people or groups
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[90vw] p-0">
          <div className="border-b p-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              aria-label="Search people and groups"
              className="h-8"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto overscroll-contain p-1">
            {filtered.length === 0 ? (
              <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                No users or groups found.
              </p>
            ) : (
              SECTIONS.map(({ kind, title, Icon }) => {
                const rows = filtered.filter((o) => o.kind === kind);
                if (rows.length === 0) return null;
                return (
                  <div key={kind} className="mb-1">
                    <p className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium tracking-wide uppercase">
                      <Icon className="size-3" aria-hidden />
                      {title}
                    </p>
                    {rows.map((o) => (
                      <label
                        key={`${o.kind}:${o.id}`}
                        className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5"
                      >
                        <Checkbox
                          checked={isSelected(o)}
                          onCheckedChange={() => toggle(o)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            {o.label}
                          </span>
                          {o.sub && (
                            <span className="text-muted-foreground block truncate text-xs">
                              {o.sub}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
