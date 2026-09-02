"use client";

import { useId, useState } from "react";
import { Lock } from "lucide-react";
import { Label } from "@onecli/ui/components/label";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { intersectPolicies } from "@onecli/api/lib/resource-axis";
import { granularAccessConfigs } from "@/ee/granular-access";
import { usePlanGate } from "@/lib/plan-gate";
import type { Connection } from "@/lib/api";

export interface ResourceScopeFieldsProps {
  /** The single connection this rule targets (per-connection granular scoping). */
  connection: Connection;
  /** The rule's granular session policy (object `conditions`), or null = all. */
  policy: Record<string, unknown> | null;
  onChange: (policy: Record<string, unknown> | null) => void;
  /** Summary-only presentation (no Manage): org-granted rows, in-flight saves. */
  readOnly?: boolean;
  /** The ORG's boundary for this (agent, connection): how far the organization
   * allows the credential to reach. The selection here narrows WITHIN it —
   * resources outside are shown but not selectable — and what the gateway
   * enforces is the overlap of the two. */
  orgPolicy?: Record<string, unknown> | null;
}

/**
 * The "Resources" sub-section of the App target: for a provider that supports
 * granular per-resource scoping (GitHub repositories, Dropbox folders), limit the
 * connection's INJECTED credential to specific resources. It writes the rule's
 * `conditions` as the provider's session-policy object (the exact shape the
 * gateway's `granular_access` guard enforces), reusing the provider's existing
 * picker dialog (which carries its own team-tier entitlement UX). Renders nothing
 * for providers without granular scoping. Per-connection (single connection).
 */
export const ResourceScopeFields = ({
  connection,
  policy,
  onChange,
  readOnly = false,
  orgPolicy = null,
}: ResourceScopeFieldsProps) => {
  const planGate = usePlanGate();
  // Resource scoping (#39) is licensed — the picker guards, and leftover
  // saved scopes are flagged as not enforced (the gateway stamps none).
  const licenseLocked = planGate.isLocked("granular_access");
  const meta = (connection.metadata as Record<string, unknown> | null) ?? {};
  const config = granularAccessConfigs.get(connection.provider);
  const labelId = useId();
  // Draft while the dialog is open — committed on Save, discarded on Cancel.
  const [draft, setDraft] = useState<Record<string, unknown> | null>(policy);
  const [open, setOpen] = useState(false);

  if (!config || !config.isSupported(meta) || !config.PolicyDialogContent) {
    return null;
  }
  const { singular, plural } = config.itemLabel;
  const Content = config.PolicyDialogContent;
  const Icon = config.Icon;

  // What the credential actually reaches: this selection narrowed to the
  // organization's boundary. With no selection the boundary itself is the
  // answer; with no boundary the selection stands alone.
  const effective = intersectPolicies(orgPolicy, policy);
  const selected = effective ? config.getSelectedItems(effective) : [];
  const emptyScope = effective !== null && selected.length === 0;
  const summary = emptyScope
    ? `No ${plural}`
    : config.formatSummary
      ? config.formatSummary(effective, meta)
      : selected.length > 0
        ? `${selected.length} ${selected.length === 1 ? singular : plural}`
        : `All ${plural}`;
  const editable = !readOnly;

  return (
    <div className="space-y-1.5" role="group" aria-labelledby={labelId}>
      <Label id={labelId}>Resources</Label>
      <div className="bg-card flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{summary}</span>
        </span>
        {editable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Manage resources"
            onClick={() => {
              if (planGate.guard("granular_access")) return;
              setDraft(policy);
              setOpen(true);
            }}
          >
            {licenseLocked && <Lock aria-hidden className="size-3" />}
            Manage
          </Button>
        )}
      </div>
      {licenseLocked && effective !== null ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
          Saved resource limits are not enforced without an Enterprise license.
          This credential currently reaches all {plural}.
        </p>
      ) : emptyScope ? (
        <p className="text-destructive text-xs" role="status">
          Nothing selected here is allowed by your organization, so this
          connection can&apos;t reach anything. Pick from the {plural} your
          organization allows, or ask an administrator to widen them.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          {orgPolicy
            ? `Limit which ${plural} this connection's injected credential can reach, within the ${plural} your organization allows.`
            : `Limit which ${plural} this connection's injected credential can reach.`}
        </p>
      )}

      {editable && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="gap-0 p-0 sm:max-w-lg">
            <DialogHeader className="p-6 pb-4">
              <DialogTitle>{connection.label ?? connection.id}</DialogTitle>
              <DialogDescription>
                Choose which {plural} this connection&apos;s credential can
                reach.
              </DialogDescription>
            </DialogHeader>
            <Content
              connectionId={connection.id}
              metadata={meta}
              policy={draft}
              orgBoundary={orgPolicy}
              onPolicyChange={setDraft}
              onSave={() => {
                // An empty selection ≡ "all" — normalize it to null so the stored
                // policy and the summary agree (a non-null empty list is ambiguous
                // at the gateway).
                onChange(
                  draft && config.getSelectedItems(draft).length > 0
                    ? draft
                    : null,
                );
                setOpen(false);
              }}
              onCancel={() => setOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
