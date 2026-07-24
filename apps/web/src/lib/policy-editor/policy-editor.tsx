"use client";

import { useCallback, useMemo, useState } from "react";
import { Building2, Folder, Loader2, Plus, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useAgents } from "@/hooks/use-agents";
import {
  useDeletePolicyRule,
  usePolicyDefault,
  usePolicyRules,
  usePublishedPolicyDefault,
  usePublishedPolicyRules,
  useReorderPolicyRules,
  useUpdatePolicyRule,
} from "@/hooks/use-policy";
import type { PageScope, PolicyRuleV2 } from "@/lib/api";
import { buildReorderIds } from "@onecli/api/lib/build-reorder-ids";
import { diffPolicyChanges } from "@onecli/api/lib/policy-diff";
import { findPolicyOverlaps } from "@onecli/api/lib/policy-overlap";
import { PolicyFilter } from "./policy-preview/policy-filter";
import { identityText, targetText } from "./policy-preview/policy-rule-display";
import { DeleteRuleDialog } from "./delete-rule-dialog";
// The staged-publish chrome, org guardrails, and directory names are the
// edition seam: EE aliases this to the real chrome; OSS renders none of it
// (immediate apply, project scope only).
// MUST be the alias key, never a relative path: turbopack resolveAlias only
// rewrites as-written `@/` specifiers, so a relative import would load the OSS
// module in every edition.
import {
  OrgGuardrails,
  StagedActions,
  StagedMeta,
  useDirectoryNames,
} from "@/lib/policy-editor/editor-chrome";
import { HowRulesEvaluated } from "./how-rules-evaluated";
import { PolicyRuleForm } from "./policy-rule-form";
import { PolicyRulesTable } from "./policy-rules-table";

export interface PolicyEditorProps {
  /** "project" renders org guardrails read-only above the editable project rules;
   * "organization" edits the org guardrails directly. */
  scope: PageScope;
}

/**
 * The editable policy console. Rules apply top-down, first match wins — the
 * order is the user's: rules stay where they're put (editing never moves one),
 * new rules append, and custom rows drag to reorder. Custom rules — including
 * the former App Permissions rules, adopted as customs at the editing cutover —
 * are editable in a right-side drawer; the remaining derived rows (blocklist,
 * plus any mid-deploy app_permission straggler awaiting its adoption re-tag)
 * render read-only. Edits stage into a draft; Publish enforces them.
 */
export const PolicyEditor = ({ scope }: PolicyEditorProps) => {
  const isProject = scope === "project";

  const draft = usePolicyRules(scope);
  const published = usePublishedPolicyRules(scope);
  const draftDefault = usePolicyDefault(scope);
  const publishedDefault = usePublishedPolicyDefault(scope);
  // Project-scoped (agents belong to a project); at org scope it's disabled — org
  // rules render/target "all agents", so agent names aren't needed there.
  const { data: agents = [] } = useAgents(isProject);
  // Directory identities appear on org rules (and the org guardrails shown in
  // the project view) — resolved through the edition seam (EE: the org-admin-
  // gated directory reads; OSS: always undefined, identities fall back to id).
  const directoryName = useDirectoryNames();

  const updateMutation = useUpdatePolicyRule(scope);
  const deleteMutation = useDeletePolicyRule(scope);
  const reorderMutation = useReorderPolicyRules(scope);

  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyRuleV2 | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PolicyRuleV2 | null>(null);

  const rules = useMemo(() => draft.data ?? [], [draft.data]);
  const q = query.trim().toLowerCase();
  const identityName = useCallback(
    (id: string): string =>
      agents.find((a) => a.id === id)?.name ?? directoryName(id) ?? id,
    [agents, directoryName],
  );

  // The staged diff (custom rules + the Default action; system-derived rows are
  // invisible by design). Null while ANY of the four queries is still loading —
  // no flicker of the changes badge on a half-resolved cache.
  const policyDiff = useMemo(() => {
    if (
      !draft.data ||
      !published.data ||
      draftDefault.isPending ||
      publishedDefault.isPending
    )
      return null;
    return diffPolicyChanges(
      draft.data,
      published.data,
      draftDefault.data,
      publishedDefault.data,
    );
  }, [
    draft.data,
    published.data,
    draftDefault.isPending,
    draftDefault.data,
    publishedDefault.isPending,
    publishedDefault.data,
  ]);
  const matches = useCallback(
    (rule: PolicyRuleV2) =>
      !q ||
      rule.name.toLowerCase().includes(q) ||
      identityText(rule, identityName).toLowerCase().includes(q) ||
      rule.targets.some((t) => targetText(t).toLowerCase().includes(q)),
    [q, identityName],
  );

  const editableRules = useMemo(
    // Equipment rules (source="equipment") are INJECTION-ONLY — the block/allow
    // engine drops them BY SOURCE (assemble_v2 / the simulator's load), so their
    // connection/secret targets never decide — and they are managed via the
    // agent access UI, not here. Hide them from the block/allow console so
    // they don't render as unlabeled, un-editable "allow" rows.
    () =>
      rules
        .filter((r) => !r.isDefault && r.source !== "equipment")
        .filter(matches),
    [rules, matches],
  );

  // Provably-dead rules (duplicates / conflicts / shadowed) — computed over the
  // FULL unfiltered draft (a filtered subset would mis-compute shadows), keyed
  // by logicalId for the row chips. Zero-false-positive by construction.
  const overlapState = useMemo(() => {
    const warnings = findPolicyOverlaps(
      rules.filter((r) => !r.isDefault && r.source !== "equipment"),
    );
    return new Map(warnings.map((w) => [w.logicalId, w]));
  }, [rules]);

  // The drag/Move handlers emit the new CUSTOM relative order; the API takes
  // the FULL draft permutation (derived + hidden equipment rows keep their
  // slots), rebuilt from the same snapshot the optimistic cache updates.
  const { mutate: applyReorder } = reorderMutation;
  const handleReorder = useCallback(
    (newCustomOrder: string[]) => {
      if (!draft.data) return;
      applyReorder(buildReorderIds(draft.data, newCustomOrder));
    },
    [draft.data, applyReorder],
  );
  // One reorder at a time; a filtered list is not the true order, so lock it
  // too (the grips explain why via their tooltip).
  const reorderLocked =
    reorderMutation.isPending || draft.isFetching || q !== "";

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (rule: PolicyRuleV2) => {
    setEditing(rule);
    setFormOpen(true);
  };
  const toggleEnabled = (rule: PolicyRuleV2) =>
    updateMutation.mutate({ id: rule.id, input: { enabled: !rule.enabled } });
  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteMutation.mutate(pendingDelete.id, {
      onSuccess: () => setPendingDelete(null),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* One quiet cluster per kind of thing: find (filter + the how-it-works
          popover) on the left; act (test / apply / add) on the right. The
          unpublished count rides INSIDE Apply Changes so state and its action
          read as one element. Stacks into two calm rows below lg. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1">
          <PolicyFilter value={query} onChange={setQuery} />
          <HowRulesEvaluated />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StagedActions scope={scope} policyDiff={policyDiff} />
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            Add Rule
          </Button>
        </div>
      </div>
      <StagedMeta scope={scope} />

      {draft.isError ? (
        <div
          role="alert"
          className="bg-card flex flex-col items-center gap-3 rounded-xl border py-12 text-center"
        >
          <div className="bg-destructive/10 flex size-10 items-center justify-center rounded-full">
            <TriangleAlert className="text-destructive size-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium">
              Couldn&rsquo;t load the policy
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Try refreshing the page.
            </p>
          </div>
        </div>
      ) : draft.isPending ? (
        <div
          role="status"
          aria-live="polite"
          className="bg-card flex items-center justify-center rounded-xl border py-16"
        >
          <Loader2
            className="text-muted-foreground size-5 animate-spin"
            aria-hidden
          />
          <span className="sr-only">Loading policy…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {isProject && (
            <OrgGuardrails
              query={query}
              identityName={identityName}
              onEdit={openEdit}
              onToggleEnabled={toggleEnabled}
              onDelete={setPendingDelete}
            />
          )}
          {overlapState.size > 0 && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden
              />
              <p>
                <span className="font-medium">
                  {overlapState.size}{" "}
                  {overlapState.size === 1
                    ? "rule can never apply."
                    : "rules can never apply."}
                </span>{" "}
                <span className="text-muted-foreground">
                  A rule above them already decides everything they match — look
                  for the Unreachable, Conflicts, and Duplicate tags below.
                </span>
              </p>
            </div>
          )}
          <PolicyRulesTable
            title={isProject ? "Project rules" : "Organization rules"}
            icon={isProject ? Folder : Building2}
            rules={editableRules}
            editable
            identityName={identityName}
            emptyLabel={
              q
                ? `No rules match “${query.trim()}”.`
                : "No rules yet. Add your first rule to get started."
            }
            // The uniform per-level default law (step 9): each level's verdict
            // is its first matching rule, else its Default Rule — deny wins.
            // The gateway enforces the project default like the org one; Block
            // turns the project into an allowlist (org allows must be mirrored
            // by a project rule), so the row is editable at both scopes.
            defaultRule={draftDefault.data ?? null}
            scope={scope}
            diffState={policyDiff?.rowState}
            overlapState={overlapState}
            defaultChanged={!!policyDiff?.defaultChange}
            onReorder={handleReorder}
            reorderLocked={reorderLocked}
            onEdit={openEdit}
            onToggleEnabled={toggleEnabled}
            onDelete={setPendingDelete}
          />
        </div>
      )}

      <PolicyRuleForm
        scope={scope}
        rule={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
      <DeleteRuleDialog
        rule={pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleteMutation.isPending}
      />
    </div>
  );
};
