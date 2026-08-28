"use client";

import { useMemo, useState } from "react";
import { Lock, Plus, UserRound, Users, X } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Input } from "@onecli/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import type { ProjectionIdentity } from "@/lib/api";
import { useGroups } from "@/hooks/use-groups";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { usePlanGate } from "@/lib/plan-gate";

type Kind = "group" | "user";

interface Option {
  kind: Kind;
  id: string;
  label: string;
  sub?: string;
}

const SECTIONS: { kind: Kind; title: string; Icon: typeof Users }[] = [
  { kind: "group", title: "User groups", Icon: Users },
  { kind: "user", title: "Users", Icon: UserRound },
];

const chipIcon = (type: ProjectionIdentity["type"]) =>
  type === "group" ? Users : UserRound;

const identityKey = (i: { type: string; id: string }) => `${i.type}:${i.id}`;

export interface OrgIdentityPickerProps {
  value: ProjectionIdentity[];
  onChange: (next: ProjectionIdentity[]) => void;
  /** Id for the trigger, so a field <Label htmlFor> associates with the picker. */
  id?: string;
}

// Stable empty fallback: the admin-gated reads leave `data` permanently
// undefined for non-admins (`retry: false` on a 403), and a fresh `[]`
// default would re-mint each render and defeat the options memo.
const EMPTY: never[] = [];

/**
 * The org policy-rule "Applies to" picker: select any mix of users and
 * user-groups (empty = all agents / "any"). A popover over a searchable
 * checkbox list grouped by kind; selections show as removable chips.
 * EE-only — the directory reads are org-admin-gated (empty for non-admins).
 */
export const OrgIdentityPicker = ({
  value,
  onChange,
  id,
}: OrgIdentityPickerProps) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { isLocked, guard } = usePlanGate();
  // The GROUP arm is enterprise (#51); user targeting stays free. The 403 on
  // the (dark) group read is absorbed by the same retry-free machinery as the
  // non-admin case — `groups` simply stays empty.
  const groupsLocked = isLocked("groups");
  const { data: groups = EMPTY } = useGroups();
  const { data: members = EMPTY } = useOrgMembersList(true);

  const allOptions = useMemo<Option[]>(
    () => [
      ...groups.map((g) => ({
        kind: "group" as const,
        id: g.id,
        label: g.name,
        sub: `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`,
      })),
      ...members
        .filter((m) => !m.email.endsWith("@onecli.internal"))
        .map((m) => ({
          kind: "user" as const,
          id: m.userId,
          label: m.name ?? m.email,
          sub: m.name ? m.email : undefined,
        })),
    ],
    [groups, members],
  );

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? allOptions.filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          o.sub?.toLowerCase().includes(needle),
      )
    : allOptions;

  const selectedKeys = useMemo(() => new Set(value.map(identityKey)), [value]);

  const toggle = (o: Option) => {
    const key = `${o.kind}:${o.id}`;
    onChange(
      selectedKeys.has(key)
        ? value.filter((i) => identityKey(i) !== key)
        : [...value, { type: o.kind, id: o.id }],
    );
  };
  const remove = (i: ProjectionIdentity) =>
    onChange(value.filter((x) => identityKey(x) !== identityKey(i)));

  const labelFor = (i: ProjectionIdentity): string => {
    const known = allOptions.find(
      (o) => o.kind === i.type && o.id === i.id,
    )?.label;
    if (known) return known;
    // Unlicensed, group names are unreadable (dark reads) — a saved group
    // target renders as a generic locked chip, never a raw UUID.
    if (i.type === "group" && groupsLocked) return "Enterprise group";
    return i.id;
  };

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((i) => {
            const Icon = chipIcon(i.type);
            return (
              <Badge
                key={identityKey(i)}
                variant="secondary"
                className="gap-1 rounded-md py-1 pr-1 pl-2 font-normal"
              >
                <Icon className="size-3 shrink-0" aria-hidden />
                <span className="max-w-[160px] truncate">{labelFor(i)}</span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="hover:bg-background/60 ml-0.5 rounded-sm p-0.5"
                  aria-label={`Remove ${labelFor(i)}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </Badge>
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Applies to every agent in the organization. Add users or user groups
          to narrow it to their workspaces&apos; agents.
        </p>
      )}

      {/* `modal`: same constraint as AppSelect — inside the modal rule-form
          Sheet the popover portals outside the sheet's scroll-lock allowlist,
          so its list can't wheel-scroll without its own scroll layer. */}
      <Popover modal open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            className="text-muted-foreground w-full justify-start border-dashed font-normal"
          >
            <Plus className="size-4" />
            Add user or user group
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[90vw] p-0">
          <div className="border-b p-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="h-8"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto overscroll-contain p-1">
            {filtered.length === 0 && !groupsLocked ? (
              <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                No identities found.
              </p>
            ) : (
              SECTIONS.map(({ kind, title, Icon }) => {
                // Unlicensed, the group half is one locked, non-selectable row
                // that opens the license dialog instead of a checkbox list.
                if (kind === "group" && groupsLocked) {
                  return (
                    <div key={kind} className="mb-1">
                      <p className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium tracking-wide uppercase">
                        <Icon className="size-3" aria-hidden />
                        {title}
                      </p>
                      <button
                        type="button"
                        onClick={() => guard("groups")}
                        className="hover:bg-muted text-muted-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                      >
                        <Lock className="size-3 shrink-0" aria-hidden />
                        Requires an Enterprise license
                      </button>
                    </div>
                  );
                }
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
                          checked={selectedKeys.has(`${o.kind}:${o.id}`)}
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
