"use client";

import { useCallback, useMemo, useState } from "react";
import { Building2, Loader2, Plus, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  useDeletePolicyRule,
  usePolicyDefault,
  usePolicyRules,
  useReorderPolicyRules,
  useUpdatePolicyRule,
} from "@/hooks/use-policy";
import type { PageScope, PolicyRuleV2 } from "@/lib/api";
import { buildReorderIds } from "@onecli/api/lib/build-reorder-ids";
import { findPolicyOverlaps } from "@onecli/api/lib/policy-overlap";
import { PolicyFilter } from "./policy-preview/policy-filter";
import { identityText, targetText } from "./policy-preview/policy-rule-display";
import { DeleteRuleDialog } from "./delete-rule-dialog";
// Directory names for the identities org rules target (org-admin-gated reads;
// a non-admin falls back to the raw id).
import { useDirectoryNames } from "@/lib/policy-editor/editor-chrome";
import { HowRulesEvaluated } from "./how-rules-evaluated";
import { PolicyRuleForm } from "./policy-rule-form";
import { PolicyRulesTable } from "./policy-rules-table";

export interface PolicyEditorProps {
  /** "workspace" renders org guardrails read-only above the editable workspace rules;
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
 * render read-only. Every edit is enforced as soon as it saves.
 */
export const PolicyEditor = ({ scope }: PolicyEditorProps) => {
  const rulesQuery = usePolicyRules(scope);
  const defaultQuery = usePolicyDefault(scope);
  // Directory identities are what org rules target — resolved through the
  // edition seam (EE: the org-admin-gated directory reads; OSS: always
  // undefined, identities fall back to the raw id). The agent-name lookup that
  // used to sit here went with the workspace page in step 6: `useAgents` was
  // already disabled at org scope, so this reads identically.
  const directoryName = useDirectoryNames();

  const updateMutation = useUpdatePolicyRule(scope);
  const deleteMutation = useDeletePolicyRule(scope);
  const reorderMutation = useReorderPolicyRules(scope);

  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyRuleV2 | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PolicyRuleV2 | null>(null);

  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);
  const q = query.trim().toLowerCase();
  const identityName = useCallback(
    (id: string): string => directoryName(id) ?? id,
    [directoryName],
  );

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
    // engine drops them BY SOURCE (assemble_v2 / the injection load keeps them,
    // the decision load doesn't), so their connection/secret targets never
    // decide. They used to be hidden here because the agent-access dialogs
    // managed them; those are gone, so hiding them would leave a live credential
    // grant with no way to revoke it. They render labelled "Credential grant",
    // not editable, but disable/delete are available.
    () => rules.filter((r) => !r.isDefault).filter(matches),
    [rules, matches],
  );

  // Provably-dead rules (duplicates / conflicts / shadowed) — computed over the
  // FULL unfiltered list (a filtered subset would mis-compute shadows), keyed
  // by logicalId for the row chips. Zero-false-positive by construction.
  const overlapState = useMemo(() => {
    const warnings = findPolicyOverlaps(
      rules.filter((r) => !r.isDefault && r.source !== "equipment"),
    );
    return new Map(warnings.map((w) => [w.logicalId, w]));
  }, [rules]);

  // The drag/Move handlers emit the new CUSTOM relative order; the API takes
  // the FULL permutation (derived + hidden equipment rows keep their
  // slots), rebuilt from the same snapshot the optimistic cache updates.
  const { mutate: applyReorder } = reorderMutation;
  const handleReorder = useCallback(
    (newCustomOrder: string[]) => {
      if (!rulesQuery.data) return;
      applyReorder(buildReorderIds(rulesQuery.data, newCustomOrder));
    },
    [rulesQuery.data, applyReorder],
  );
  // One reorder at a time; a filtered list is not the true order, so lock it
  // too (the grips explain why via their tooltip).
  const reorderLocked =
    reorderMutation.isPending || rulesQuery.isFetching || q !== "";

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
      {/* Find (filter + the how-it-works popover) on the left; Add on the
          right. Stacks into two calm rows below lg. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1">
          <PolicyFilter value={query} onChange={setQuery} />
          <HowRulesEvaluated />
        </div>
        <Button onClick={openCreate} className="self-start lg:self-auto">
          <Plus className="size-4" />
          Add Rule
        </Button>
      </div>

      {rulesQuery.isError ? (
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
      ) : rulesQuery.isPending ? (
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
                  A rule above them already decides everything they match. Look
                  for the Unreachable, Conflicts, and Duplicate tags below.
                </span>
              </p>
            </div>
          )}
          <PolicyRulesTable
            title="Organization rules"
            icon={Building2}
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
            // The gateway enforces the workspace default like the org one; Block
            // turns the workspace into an allowlist (org allows must be mirrored
            // by a workspace rule), so the row is editable at both scopes.
            defaultRule={defaultQuery.data ?? null}
            scope={scope}
            overlapState={overlapState}
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
