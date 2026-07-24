"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Input } from "@onecli/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import { cn } from "@onecli/ui/lib/utils";
import type { AppToolGroupSummary } from "@onecli/api/apps/app-permissions/types";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";

export interface AppToolsPickerProps {
  /** The provider whose catalog tools to offer; empty until an app is picked. */
  provider: string;
  /** Selected catalog tool ids — concrete tools and/or a group's wildcard id
   * (e.g. `read_all`); [] = the whole app. */
  value: string[];
  onChange: (next: string[]) => void;
  id?: string;
}

// The house group labels (mirrors app-permission-group.tsx) — the catalog
// category ("read"/"write") reads as the panel's "Read-only"/"Write / delete".
const GROUP_LABELS: Record<string, string> = {
  read: "Read-only",
  write: "Write / delete",
};

/**
 * "Narrow by tools" for the rule dialog's App target: a grouped, searchable
 * checkbox multi-select over the provider's catalog tools. Empty selection = the
 * whole app (today's behavior). Selecting tools narrows the rule to exactly
 * those endpoints (the engine's app-target tool fan-out). Used in BOTH target
 * modes — "All connections" (an `app` target) and specific connection(s) (each
 * a `connection` target); both carry the tool set and decode to the same
 * tool-narrowed app match.
 *
 * When a catalog group defines a COMPLETE WILDCARD — a server-verified true
 * superset of the group's tools (`wildcardComplete`), e.g. Gmail's "All read
 * operations" = `read_all`, a single `/gmail/v1/*` GET rule that covers every
 * Gmail read incl. future ones — the group header IS that umbrella: checking it
 * stores the one wildcard id and the concrete rows show as covered; unchecking
 * it lets you author a subset. A group with no wildcard — or one whose wildcard
 * is INCOMPLETE (e.g. Jira/Confluence read, whose search escapes the umbrella by
 * method or path) — keeps a plain "select all concrete tools" header, so the
 * picker never offers a misleading "all X". The wildcard id is a real catalog
 * tool the engine resolves, so the stored set is always enforce-resolvable.
 *
 * The catalog is the CLIENT-SAFE summary (`/v1/apps/permission-definitions`,
 * id/name/description only — endpoint mappings never reach the bundle).
 */
export const AppToolsPicker = ({
  provider,
  value,
  onChange,
  id,
}: AppToolsPickerProps) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: definitions = [], isPending } = useAppPermissionDefinitions();

  const groups = useMemo<AppToolGroupSummary[]>(
    () => definitions.find((d) => d.provider === provider)?.groups ?? [],
    [definitions, provider],
  );

  // Concrete tool ids only — the denominator for the "N of M" count.
  const allToolIds = useMemo(
    () => groups.flatMap((g) => g.tools.map((t) => t.id)),
    [groups],
  );
  // Every selectable id in catalog order (wildcard first per group, mirroring
  // `allGroupTools`) — the ordering the stored array is normalized to, so a
  // selected WILDCARD id is never dropped when rebuilding the set.
  const orderedAllIds = useMemo(
    () =>
      groups.flatMap((g) => [
        ...(g.wildcard ? [g.wildcard.id] : []),
        ...g.tools.map((t) => t.id),
      ]),
    [groups],
  );
  const selected = useMemo(() => new Set(value), [value]);

  const needle = q.trim().toLowerCase();
  // Search filters only the RENDERED rows; every group keeps its FULL row for
  // all state logic (header, count, toggle), so a filtered view can never make
  // a "select all" / umbrella toggle act on a partial set.
  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => {
          const wildcardMatches =
            !!needle &&
            !!group.wildcard &&
            (group.wildcard.name.toLowerCase().includes(needle) ||
              group.wildcard.description.toLowerCase().includes(needle));
          const rows =
            needle && !wildcardMatches
              ? group.tools.filter(
                  (t) =>
                    t.name.toLowerCase().includes(needle) ||
                    t.description.toLowerCase().includes(needle),
                )
              : group.tools;
          return { group, rows, wildcardMatches };
        })
        .filter((g) => g.rows.length > 0 || g.wildcardMatches),
    [groups, needle],
  );

  const isWildcardOn = (g: AppToolGroupSummary): boolean =>
    !!g.wildcard && selected.has(g.wildcard.id);
  // The header acts as the umbrella when the group's wildcard genuinely covers
  // the whole group (server-computed `wildcardComplete`) — OR when an
  // incomplete one is already selected (a legacy/API value), so it stays
  // visible + uncheckable. An incomplete wildcard is never OFFERED fresh: it
  // would author a misleading "all X" that misses uncovered endpoints (e.g.
  // Jira JQL POST search).
  const umbrellaActive = (g: AppToolGroupSummary): boolean =>
    !!g.wildcard && (g.wildcardComplete === true || isWildcardOn(g));

  const toggleTool = (toolId: string) => {
    const next = new Set(selected);
    if (next.has(toolId)) next.delete(toolId);
    else next.add(toolId);
    onChange(orderedAllIds.filter((tid) => next.has(tid)));
  };

  // Always operates on the FULL group (never the search-filtered rows), so the
  // umbrella-check drops the WHOLE group's concrete ids and select-all covers
  // the whole group even under an active search.
  const toggleGroup = (group: AppToolGroupSummary, checked: boolean) => {
    const next = new Set(selected);
    if (group.wildcard && umbrellaActive(group)) {
      // The umbrella: checking it stores the one wildcard id and drops this
      // group's now-subsumed concrete ids; unchecking removes just the wildcard.
      if (checked) {
        next.add(group.wildcard.id);
        group.tools.forEach((t) => next.delete(t.id));
      } else {
        next.delete(group.wildcard.id);
      }
    } else {
      // Plain "select all concrete tools".
      const ids = new Set(group.tools.map((t) => t.id));
      if (checked) ids.forEach((tid) => next.add(tid));
      else ids.forEach((tid) => next.delete(tid));
    }
    onChange(orderedAllIds.filter((tid) => next.has(tid)));
  };

  // Concrete tools of the group currently selected (0 when the umbrella is on,
  // since selecting it drops them).
  const groupSelectedCount = (group: AppToolGroupSummary): number =>
    group.tools.filter((t) => selected.has(t.id)).length;

  const noCatalog = !isPending && groups.length === 0;

  // Concrete ids subsumed by a currently-selected COMPLETE umbrella — excluded
  // from the trigger's "N more". Only a complete wildcard truly covers its
  // tools; an incomplete-but-selected one doesn't, so its group's concrete
  // selections still count.
  const coveredConcreteIds = useMemo(
    () =>
      new Set(
        groups
          .filter(
            (g) =>
              g.wildcard &&
              g.wildcardComplete === true &&
              selected.has(g.wildcard.id),
          )
          .flatMap((g) => g.tools.map((t) => t.id)),
      ),
    [groups, selected],
  );

  // Trigger summary. A selected wildcard (1 id, many ops) can't read as "N of M
  // tools", so name the umbrella(s) and append any extra concrete count; a
  // pure-concrete selection keeps the "N of M" form. The "of M" total is held
  // back until the catalog settles (staleTime: Infinity can be cold on a fresh
  // land) so an edit never flashes "N of 0".
  const selectedWildcardNames = groups
    .filter((g) => isWildcardOn(g))
    .map((g) => g.wildcard?.name)
    .filter((n): n is string => !!n);
  // Selected CONCRETE tools = those in the concrete-id set (wildcard ids aren't),
  // minus any subsumed by a selected umbrella of their own group.
  const concreteSelectedCount = value.filter(
    (v) => allToolIds.includes(v) && !coveredConcreteIds.has(v),
  ).length;
  const triggerLabel = (() => {
    if (value.length === 0) return "All tools";
    if (selectedWildcardNames.length === 0) {
      return allToolIds.length === 0
        ? `${value.length} tool${value.length === 1 ? "" : "s"}`
        : `${concreteSelectedCount} of ${allToolIds.length} tool${
            allToolIds.length === 1 ? "" : "s"
          }`;
    }
    const parts = [...selectedWildcardNames];
    if (concreteSelectedCount > 0) parts.push(`${concreteSelectedCount} more`);
    return parts.join(" · ");
  })();

  return (
    // `modal`: this popover opens inside the rule-form Sheet (a modal Radix
    // dialog); without it the scrollable list can't wheel-scroll (see
    // app-select.tsx / the modal-in-dialog scroll fix).
    <Popover
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset the search on close so a reopen starts from the full list
        // (matches the sibling AppSelect combobox in the same field).
        if (!next) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={noCatalog}
          className="bg-card hover:bg-card w-full justify-between gap-2 font-normal"
        >
          <span
            className={cn(
              "truncate",
              value.length === 0 && "text-muted-foreground",
            )}
          >
            {noCatalog ? "No tools to narrow" : triggerLabel}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) max-w-[90vw] p-0"
      >
        <div className="border-b p-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tools…"
            aria-label="Search tools"
            className="h-8"
            autoFocus
          />
        </div>
        <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {isPending ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              Loading tools…
            </p>
          ) : visibleGroups.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              {needle ? `No tools match “${q.trim()}”.` : "No tools."}
            </p>
          ) : (
            visibleGroups.map(({ group, rows }) => {
              // The header is the umbrella only when the group OFFERS one: a
              // complete wildcard, or an incomplete one already selected (a
              // legacy/API value kept visible + uncheckable). Otherwise it's a
              // plain select-all of the concrete tools.
              const umbrella = umbrellaActive(group)
                ? group.wildcard
                : undefined;
              const wildOn = isWildcardOn(group);
              const inGroup = groupSelectedCount(group);
              const allConcrete =
                group.tools.length > 0 && inGroup === group.tools.length;
              const headerChecked = umbrella ? wildOn : allConcrete;
              const headerLabel = umbrella
                ? umbrella.name
                : (GROUP_LABELS[group.category] ?? group.category);
              // Only a COMPLETE, selected umbrella truly covers its rows; an
              // incomplete-but-selected one leaves them individually selectable
              // (its tools aren't all subsumed — the reason it isn't offered
              // fresh).
              const rowsCovered = wildOn && group.wildcardComplete === true;
              // A legacy/API value selected an INCOMPLETE umbrella: the header
              // is checked but the rows aren't covered (they can't be — the
              // wildcard isn't a true superset). Without a hint this looks like
              // a complete umbrella misbehaving, so caption the one-way "clear
              // it to edit tools" affordance (it's never offered fresh).
              const incompleteUmbrellaOn = !!umbrella && wildOn && !rowsCovered;
              return (
                <div key={group.category} className="mb-1">
                  <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-xs font-semibold">
                        {headerLabel}
                        <span className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
                          {/* Fraction only while STRICTLY partial-concrete; once
                              a complete umbrella covers the group, the bare total
                              shows. */}
                          {!rowsCovered && inGroup > 0 && !allConcrete
                            ? `${inGroup}/${group.tools.length}`
                            : group.tools.length}
                        </span>
                      </span>
                      {incompleteUmbrellaOn && (
                        <span className="text-muted-foreground text-[11px] italic">
                          Uncheck to choose tools individually
                        </span>
                      )}
                    </span>
                    <Checkbox
                      checked={headerChecked}
                      onCheckedChange={(c) => toggleGroup(group, c === true)}
                      aria-label={
                        umbrella
                          ? headerLabel
                          : `Select all ${headerLabel} tools`
                      }
                    />
                  </div>
                  {rows.map((tool) => {
                    const rowId = `tool-${provider}-${tool.id}`;
                    // Under a complete, selected umbrella every concrete tool is
                    // COVERED: checked + disabled + muted, and can't be
                    // cherry-picked out (a single rule can't exclude one — that's
                    // a block rule).
                    const covered = rowsCovered;
                    const rowChecked = covered || selected.has(tool.id);
                    return (
                      <label
                        key={tool.id}
                        htmlFor={rowId}
                        className={cn(
                          "flex items-start gap-2.5 rounded-md px-2 py-1.5",
                          covered
                            ? "cursor-default"
                            : "hover:bg-muted cursor-pointer",
                        )}
                      >
                        <Checkbox
                          id={rowId}
                          className="mt-0.5"
                          checked={rowChecked}
                          disabled={covered}
                          onCheckedChange={() => {
                            if (!covered) toggleTool(tool.id);
                          }}
                        />
                        <span className="min-w-0">
                          {/* Covered rows dim the TEXT (not the whole label), so
                              the disabled checkbox keeps its own opacity and its
                              check-mark stays legible. */}
                          <span
                            className={cn(
                              "block text-sm leading-tight",
                              covered && "text-muted-foreground",
                            )}
                          >
                            {tool.name}
                            {covered && (
                              <span className="italic"> · included</span>
                            )}
                          </span>
                          {tool.description && (
                            <span className="text-muted-foreground block text-[11.5px] leading-tight">
                              {tool.description}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
