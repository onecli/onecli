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
import { canonicalPolicy } from "@onecli/api/lib/resource-axis";
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
// Edition seam: EE aliases to the real granular resource editor, OSS keeps the
// locked hint. Alias key on purpose — a relative import would bypass turbopack
// resolveAlias in EE builds.
import { ResourceScopeFields } from "@/lib/policy-editor/resource-scope";
import { PermissionGroup } from "./permission-group";
import { OtherRequestsSection } from "./other-requests-section";
import type { ToolChoice } from "./tri-state-control";
import { grantIntentFromChoices, type OtherChoices } from "./grant-intent";

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

/** The two catch-all rows as STORED: only a custom grant has them. Full
 * access (or no grant yet) stores none (see `displayedOther`). */
const storedOther = (
  grant: AgentGrantConnection | undefined,
): OtherChoices | null =>
  grant?.access === "custom"
    ? { otherReads: grant.otherReads, otherWrites: grant.otherWrites }
    : null;

/** What the two rows show, and what a save writes, is what will actually
 * happen: the user's pick on that row; else the stored custom value; else,
 * with no stored value (full access), Allowed while every tool is Allowed
 * (the save stays full access) and the provider's default the moment the
 * grid is customized (Needs approval; Never for `unlisted: "block"`), exactly
 * how unlisted requests behave today.
 *
 * A catalog that blocks unlisted requests allows them only under full access
 * (the API refuses Always allow on a customized grant), so there a row reads
 * Allowed only while every tool is Allowed too; otherwise it falls back to
 * its stored choice, else Never. */
const displayedOther = (
  edits: Partial<OtherChoices>,
  stored: OtherChoices | null,
  allToolsAllow: boolean,
  unlisted: "block" | undefined,
): OtherChoices => {
  const fallback: ToolChoice = allToolsAllow
    ? "allow"
    : unlisted === "block"
      ? "never"
      : "ask";
  const shown = (key: keyof OtherChoices): ToolChoice => {
    const choice = edits[key] ?? stored?.[key] ?? fallback;
    if (unlisted !== "block" || choice !== "allow" || allToolsAllow) {
      return choice;
    }
    const kept = stored?.[key];
    return kept !== undefined && kept !== "allow" ? kept : "never";
  };
  return { otherReads: shown("otherReads"), otherWrites: shown("otherWrites") };
};

export const ManagePermissionsDialog = ({
  agentId,
  connection,
  grant,
  readOnly,
  readOnlyReason = "org-granted",
  onClose,
}: ManagePermissionsDialogProps) => {
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
  const [otherEdits, setOtherEdits] = useState<Partial<OtherChoices>>({});
  const [stored, setStored] = useState<OtherChoices | null>(null);
  const [resources, setResources] = useState<GrantResources | null>(null);
  const [initialResources, setInitialResources] =
    useState<GrantResources | null>(null);
  useEffect(() => {
    // Resources ride the same retarget seeding as the tri-state — so a
    // catalog-less provider (toolIds empty) never seeds or shows them either.
    // Fine for github-app/dropbox/google-drive (all cataloged); a future granular provider
    // without a tool catalog would need this revisited.
    if (connection === null || toolIds.length === 0) return;
    const derived = deriveChoices(toolIds, grant);
    setChoices(derived);
    setInitial(derived);
    setOtherEdits({});
    setStored(storedOther(grant));
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

  const setTool = (toolId: string, choice: ToolChoice) => {
    setChoices((prev) => ({ ...prev, [toolId]: choice }));
  };
  const setGroup = (ids: string[], choice: ToolChoice) => {
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
  const allowAll = (c: Record<string, ToolChoice>) =>
    toolIds.length > 0 && toolIds.every((id) => c[id] === "allow");
  const other = displayedOther(
    otherEdits,
    stored,
    allowAll(choices),
    definition?.unlisted,
  );
  const initialOther = displayedOther(
    {},
    stored,
    allowAll(initial),
    definition?.unlisted,
  );
  const unchanged =
    toolIds.every((id) => choices[id] === initial[id]) &&
    other.otherReads === initialOther.otherReads &&
    other.otherWrites === initialOther.otherWrites;
  // What a save writes.
  const intent = grantIntentFromChoices(toolIds, choices, other);
  // Key-stable compare is enough: both sides come from the same source (the
  // stored grant, or the picker's committed draft).
  const resourcesUnchanged =
    JSON.stringify(resources) === JSON.stringify(initialResources);
  // Whether the grant is full as STORED: the notice about requests outside
  // the list, and the one case `unchanged` can't see on its own (a custom
  // grant whose grid already shows full access, which a save converts). It
  // must NOT gate what `handleSave` writes (see `grantIntentFromChoices`).
  const wasFull = grant === undefined || grant.access === "full";
  const accessUnchanged = (intent.access === "full") === wasFull;

  const handleSave = () => {
    if (connection === null) return;
    save.mutate(
      {
        agentId,
        connectionId: connection.id,
        // `resources` rides ONLY when actually edited: an omitted field is the
        // server's PRESERVE arm — tools-only saves never hit the resources
        // validator (a free-plan agent with a carried restriction must still
        // be able to edit tools), and unchanged saves stay idempotent.
        input: resourcesUnchanged ? intent : { ...intent, resources },
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
                  applies your choices below.
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
                  // The pickers emit one axis; `canonicalPolicy` narrows it to
                  // the wire union (anything else → null, unrestricted).
                  onChange={(p) => setResources(canonicalPolicy(p))}
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
                  onToolSelect={setTool}
                  onGroupSelect={setGroup}
                />
              ))}
              <OtherRequestsSection
                other={other}
                unlisted={definition.unlisted}
                allToolsAllowed={allowAll(choices)}
                readOnly={readOnly || save.isPending}
                onChange={setOtherEdits}
              />
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
                (unchanged && resourcesUnchanged && accessUnchanged) ||
                allNever ||
                save.isPending
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
