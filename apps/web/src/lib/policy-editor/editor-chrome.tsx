"use client";

import { useCallback, useMemo, useState } from "react";
import { CloudUpload } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import type { PolicyDiff } from "@onecli/api/lib/policy-diff";
import { formatRelative } from "@onecli/api/lib/format";
import { useGroups } from "@/hooks/use-groups";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { usePolicyLastPublish, usePublishPolicy } from "@/hooks/use-policy";
import type { PageScope } from "@/lib/api";
import {} from "@/lib/policy-editor/policy-preview/policy-rule-display";
import { ReviewChangesDialog } from "./_components/review-changes-dialog";

/**
 * The EE editor chrome (aliased over `@/lib/policy-editor/editor-chrome`): the
 * staged publish surface — Apply Changes with the unpublished
 * count and review dialog, the last-applied line — plus the org-guardrails
 * section and directory name resolution. §2.9 keeps all of this cloud/EE; the
 * OSS module renders none of it (immediate-apply, workspace scope only).
 */

// Stable empty fallback: the admin-gated reads leave `data` permanently
// undefined for non-admins (`retry: false` on a 403), and a fresh `[]`
// default would re-mint each render and defeat every memo downstream.
const EMPTY: never[] = [];

export const useDirectoryNames = (): ((id: string) => string | undefined) => {
  // Org-admin-gated reads — empty for non-admins, in which case an identity
  // falls back to its id.
  const { data: groups = EMPTY } = useGroups();
  const { data: members = EMPTY } = useOrgMembersList(true);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of members) byId.set(m.userId, m.name ?? m.email);
    for (const g of groups) byId.set(g.id, g.name);
    return byId;
  }, [groups, members]);
  return useCallback((id: string) => names.get(id), [names]);
};

export interface StagedActionsProps {
  scope: PageScope;
  policyDiff: PolicyDiff | null;
}

/** The Apply-Changes cluster (staged model) — org scope only since attach-model
 * step 2: workspace writes are write-through (the publish-mode seam), so there is
 * nothing to stage there. */
export const StagedActions = ({ scope, policyDiff }: StagedActionsProps) => {
  const isWorkspace = scope === "workspace";
  const publishMutation = usePublishPolicy(scope);
  const [reviewOpen, setReviewOpen] = useState(false);
  const changeCount = policyDiff?.count ?? 0;
  const hasUnpublished = changeCount > 0;
  if (isWorkspace) return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => setReviewOpen(true)}
        disabled={!hasUnpublished}
        loading={publishMutation.isPending}
      >
        <CloudUpload className="size-4" />
        {publishMutation.isPending ? "Applying…" : "Apply Changes"}
        {hasUnpublished && !publishMutation.isPending && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-xs font-semibold text-amber-700 tabular-nums dark:text-amber-400">
            {changeCount}
            <span className="sr-only">
              {" "}
              unpublished {changeCount === 1 ? "change" : "changes"}
            </span>
          </span>
        )}
      </Button>
      {policyDiff && (
        <ReviewChangesDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          diff={policyDiff}
          isWorkspace={isWorkspace}
          applying={publishMutation.isPending}
          onApply={() =>
            publishMutation.mutate(undefined, {
              onSuccess: () => setReviewOpen(false),
            })
          }
        />
      )}
    </>
  );
};

/** The "Last applied by …" line under the toolbar (staged model) — org only:
 * at write-through workspace scope it would refresh to "just now" on every
 * toggle, which is noise, not information. */
export const StagedMeta = ({ scope }: { scope: PageScope }) => {
  const lastPublish = usePolicyLastPublish(scope);
  if (scope === "workspace") return null;
  if (!lastPublish.data) return null;
  return (
    <p className="text-muted-foreground -mt-2 text-xs lg:text-right">
      Last applied by {lastPublish.data.appliedBy?.email ?? "System"} ·{" "}
      {formatRelative(lastPublish.data.appliedAt)}
    </p>
  );
};

/** The EE editions evaluate org guardrails above workspace rules — the
 * explainer describes the two-level model. The OSS arm exports `false`. */
export const ORG_GUARDRAILS_AVAILABLE = true;
