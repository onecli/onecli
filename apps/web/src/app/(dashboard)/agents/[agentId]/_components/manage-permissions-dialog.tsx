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
import type { AgentGrantConnection, Connection } from "@/lib/api";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { useSetConnectionGrant } from "@/hooks/use-grants";
import {
  useEffectiveAppPermissions,
  type EffectiveToolResult,
} from "@/lib/api/policy-visibility";
import { usePlanGate } from "@/lib/plan-gate";
import { PermissionGroup } from "./permission-group";
import type { ToolChoice } from "./tri-state-control";

interface ManagePermissionsDialogProps {
  agentId: string;
  /** The dialog is open while a connection is set (the delete-rule-dialog
   * derived-open pattern). */
  connection: Connection | null;
  /** The project grant, when one exists — seeds the tri-state. */
  grant: AgentGrantConnection | undefined;
  /** Org-granted rows: visible but not editable at project level. */
  readOnly: boolean;
  onClose: () => void;
}

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
    "project",
    connection !== null,
    connection?.id ?? null,
  );

  const [choices, setChoices] = useState<Record<string, ToolChoice>>({});
  const [initial, setInitial] = useState<Record<string, ToolChoice>>({});
  useEffect(() => {
    if (connection === null || toolIds.length === 0) return;
    const derived = deriveChoices(toolIds, grant);
    setChoices(derived);
    setInitial(derived);
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
  const wasFull = grant === undefined || grant.access === "full";
  const allAllow = toolIds.every((id) => choices[id] === "allow");

  const handleSave = () => {
    if (connection === null) return;
    const allow = toolIds.filter((id) => choices[id] === "allow");
    const ask = toolIds.filter((id) => choices[id] === "ask");
    save.mutate(
      {
        agentId,
        connectionId: connection.id,
        // Keeping every tool allowed keeps (or creates) the uncustomized
        // whole-app grant — future catalog tools stay auto-allowed.
        input:
          allAllow && wasFull
            ? { access: "full" }
            : { access: "custom", allow, ask },
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
            {readOnly
              ? "Granted by your organization — manage in the org policy console."
              : "What this agent may do with this connection. Changes apply immediately."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-6 py-5">
          {!definitionsPending && definition === undefined ? (
            // A deep link can name a catalog-less connection (rows hide
            // Manage for those) — say so instead of spinning forever.
            <p className="text-muted-foreground py-8 text-center text-sm">
              This app has no per-tool permission catalog — access is
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
                  pins the tool list — tools added to the catalog later arrive
                  as Never until enabled.
                </p>
              )}
              {reflection.isError && (
                <div
                  role="alert"
                  className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-4 py-3 text-xs"
                >
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                  Couldn&apos;t load organization limits — locked options may be
                  missing. Saving still enforces them.
                </div>
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
              Everything set to Never — detach the connection instead.
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              onClick={handleSave}
              loading={save.isPending}
              disabled={unchanged || allNever || save.isPending}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
