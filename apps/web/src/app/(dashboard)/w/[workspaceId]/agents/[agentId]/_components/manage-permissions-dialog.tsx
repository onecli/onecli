"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@onecli/ui/components/sheet";
import { getApp } from "@onecli/api/apps/registry";
import type {
  AgentGrantConnection,
  Connection,
  GrantResources,
} from "@/lib/api";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { useSetConnectionGrant } from "@/hooks/use-grants";
import {
  useEffectiveAppPermissions,
  type EffectiveToolResult,
} from "@/lib/api/policy-visibility";
import { usePlanGate } from "@/lib/plan-gate";
// Edition seam: EE aliases to the real granular resource editor, OSS keeps the
// locked hint. Alias key on purpose — a relative import would bypass turbopack
// resolveAlias in EE builds.
import { ResourceScopeFields } from "@/lib/policy-editor/resource-scope";
import { PermissionGroup } from "./permission-group";
import type { ToolChoice } from "./tri-state-control";
import { grantIntentFromChoices } from "./grant-intent";

interface ManagePermissionsDialogProps {
  agentId: string;
  /** The dialog is open while a connection is set (the delete-rule-dialog
   * derived-open pattern). */
  connection: Connection | null;
  /** The workspace grant, when one exists — seeds the tri-state. */
  grant: AgentGrantConnection | undefined;
  /** Org-granted rows: visible but not editable at workspace level. */
  readOnly: boolean;
  /** Why it is read-only, so the description says something true: the
   * organization GRANTED this connection, or it BLOCKS it outright. */
  readOnlyReason?: "org-granted" | "org-blocked";
  onClose: () => void;
}

/** Narrow the picker's generic policy object to the wire union. The provider
 * dialogs only ever emit one well-formed axis; anything else collapses to null
 * (unrestricted) rather than sending junk to the server. */
const toGrantResources = (
  policy: Record<string, unknown> | null,
): GrantResources | null => {
  if (policy === null) return null;
  const repositories = policy["repositories"];
  if (Array.isArray(repositories)) {
    return {
      repositories: repositories.filter(
        (r): r is string => typeof r === "string",
      ),
    };
  }
  const folders = policy["folders"];
  if (Array.isArray(folders)) {
    return {
      folders: folders.filter((f): f is string => typeof f === "string"),
    };
  }
  return null;
};

/** Derive the dialog's tri-state from the stored grant: full access (or no
 * grant yet — Manage-before-attach) = everything allowed; a custom grant
 * = its allow/ask sets, the rest Never. */
const deriveChoices = (
  toolIds: string[],
  grant: AgentGrantConnection | undefined,
): Record<string, ToolChoice> => {
  const choices: Record<string, ToolChoice> = {};
  const custom = grant?.access === "custom";
  for (const id of toolIds) {
    choices[id] = custom
      ? grant.allow.includes(id)
        ? "allow"
        : grant.ask.includes(id)
          ? "ask"
          : "never"
      : "allow";
  }
  return choices;
};

export const ManagePermissionsDialog = ({
  agentId,
  connection,
  grant,
  readOnly,
  readOnlyReason = "org-granted",
  onClose,
}: ManagePermissionsDialogProps) => {
  const planGate = usePlanGate();
  const save = useSetConnectionGrant();
  const { data: definitions = [], isPending: definitionsPending } =
    useAppPermissionDefinitions();
  const definition = definitions.find(
    (d) => d.provider === connection?.provider,
  );
  const toolIds = useMemo(
    () => (definition?.groups ?? []).flatMap((g) => g.tools.map((t) => t.id)),
    [definition],
  );

  const reflection = useEffectiveAppPermissions(
    connection?.provider ?? "",
    agentId,
    connection !== null,
    connection?.id ?? null,
  );

  const [choices, setChoices] = useState<Record<string, ToolChoice>>({});
  const [initial, setInitial] = useState<Record<string, ToolChoice>>({});
  const [resources, setResources] = useState<GrantResources | null>(null);
  const [initialResources, setInitialResources] =
    useState<GrantResources | null>(null);
  useEffect(() => {
    // Resources ride the same retarget seeding as the tri-state — so a
    // catalog-less provider (toolIds empty) never seeds or shows them either.
    // Fine for github-app/dropbox (both cataloged); a future granular provider
    // without a tool catalog would need this revisited.
    if (connection === null || toolIds.length === 0) return;
    const derived = deriveChoices(toolIds, grant);
    setChoices(derived);
    setInitial(derived);
    const seededResources = grant?.resources ?? null;
    setResources(seededResources);
    setInitialResources(seededResources);
    // Re-derive only when the dialog re-targets — a background grants refetch
    // must not clobber in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, toolIds.length]);

  const ceilings = useMemo(() => {
    const map: Record<string, "allow" | "approval" | "block" | null> = {};
    for (const group of reflection.data?.groups ?? []) {
      for (const tool of group.tools) map[tool.toolId] = tool.orgCeiling;
    }
    return map;
  }, [reflection.data]);
  const effective = useMemo(() => {
    const map: Record<string, EffectiveToolResult> = {};
    for (const group of reflection.data?.groups ?? []) {
      for (const tool of group.tools) map[tool.toolId] = tool;
    }
    return map;
  }, [reflection.data]);

  const askLocked = planGate.isLocked("policy.manual_approval");

  const setTool = (toolId: string, choice: ToolChoice) => {
    if (choice === "ask" && planGate.guard("policy.manual_approval")) return;
    setChoices((prev) => ({ ...prev, [toolId]: choice }));
  };
  const setGroup = (ids: string[], choice: ToolChoice) => {
    if (choice === "ask" && planGate.guard("policy.manual_approval")) return;
    setChoices((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        // The ceiling pins what it pins — a group action skips locked rows.
        if (ceilings[id] === "block") continue;
        if (ceilings[id] === "approval" && choice === "allow") continue;
        next[id] = choice;
      }
      return next;
    });
  };

  // The attached ⇔ allow∪ask ≠ ∅ invariant, mirrored client-side: an
  // all-Never state is a detach, not a save (the server 422s it too).
  const allNever =
    toolIds.length > 0 && toolIds.every((id) => choices[id] === "never");
  const unchanged = toolIds.every((id) => choices[id] === initial[id]);
  // Key-stable compare is enough: both sides come from the same source (the
  // stored grant, or the picker's committed draft).
  const resourcesUnchanged =
    JSON.stringify(resources) === JSON.stringify(initialResources);
  // Presentational only: whether the grant is full as STORED, used for the
  // "customizing pins the tool list" notice. It must NOT gate what `handleSave`
  // writes — see `grantIntentFromChoices`.
  const wasFull = grant === undefined || grant.access === "full";

  const handleSave = () => {
    if (connection === null) return;
    const base = grantIntentFromChoices(toolIds, choices);
    save.mutate(
      {
        agentId,
        connectionId: connection.id,
        // `resources` rides ONLY when actually edited: an omitted field is the
        // server's PRESERVE arm — tools-only saves never hit the resources
        // validator (a free-plan agent with a carried restriction must still
        // be able to edit tools), and unchanged saves stay idempotent.
        input: resourcesUnchanged ? base : { ...base, resources },
      },
      { onSuccess: () => onClose() },
    );
  };

  const app = connection ? getApp(connection.provider) : undefined;
  const title = connection
    ? (connection.label ?? app?.name ?? connection.provider)
    : "";

  return (
    <Sheet open={connection !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>Manage permissions · {title}</SheetTitle>
          <SheetDescription>
            {!readOnly
              ? "What this agent may do with this connection. Changes apply immediately."
              : readOnlyReason === "org-blocked"
                ? "Blocked by your organization. Nothing here can grant access until that changes."
                : "Granted by your organization. Manage it in the org policy console."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-6 py-5">
          {!definitionsPending && definition === undefined ? (
            // A deep link can name a catalog-less connection (rows hide
            // Manage for those) — say so instead of spinning forever.
            <p className="text-muted-foreground py-8 text-center text-sm">
              This app has no per-tool permission catalog. Access is
              all-or-nothing via the attach toggle.
            </p>
          ) : reflection.isPending || definition === undefined ? (
            <div className="flex items-center justify-center py-12">
              <Loader2
                className="text-muted-foreground size-5 animate-spin"
                aria-hidden
              />
              <span className="sr-only">Loading permissions…</span>
            </div>
          ) : (
            <>
              {!readOnly && wasFull && (
                <p className="text-muted-foreground text-xs">
                  This agent currently has full access. Saving a customization
                  pins the tool list, so tools added to the catalog later arrive
                  as Never until enabled.
                </p>
              )}
              {reflection.isError && (
                <div
                  role="alert"
                  className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-4 py-3 text-xs"
                >
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                  Couldn&apos;t load organization limits, so locked options may
                  be missing. Saving still enforces them.
                </div>
              )}
              {connection !== null && (
                <ResourceScopeFields
                  connection={connection}
                  policy={resources}
                  onChange={(p) => setResources(toGrantResources(p))}
                  readOnly={readOnly || save.isPending}
                  orgPolicy={reflection.data?.orgResources ?? null}
                />
              )}
              {definition.groups.map((group) => (
                <PermissionGroup
                  key={group.category}
                  group={group}
                  choices={choices}
                  ceilings={ceilings}
                  effective={effective}
                  readOnly={readOnly || save.isPending}
                  askLocked={askLocked}
                  onToolSelect={setTool}
                  onGroupSelect={setGroup}
                />
              ))}
            </>
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t px-6 py-4">
          {allNever && !readOnly && (
            <p className="text-muted-foreground mr-auto text-xs">
              Everything is set to Never. Detach the connection instead.
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              onClick={handleSave}
              loading={save.isPending}
              disabled={
                (unchanged && resourcesUnchanged) || allNever || save.isPending
              }
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
