"use client";

import { getApp } from "@onecli/api/apps/registry";
import { KeyRound, Settings2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import type { AgentGrantConnection, Connection } from "@/lib/api";
import type { CredentialAccessStatus } from "@/lib/api/policy-visibility";
import { useEffectiveAppPermissions } from "@/lib/api/policy-visibility";
import { useDetachConnection, useSetConnectionGrant } from "@/hooks/use-grants";
import { AppIcon } from "@/lib/components/app-icon";
import { EffectivePill } from "./effective-pill";

interface ConnectionGrantRowProps {
  agentId: string;
  connection: Connection;
  /** The workspace-level grant, when attached through the grants API. */
  grant: AgentGrantConnection | undefined;
  /** Injected via an ORG rule (locked on — not detachable at workspace level). */
  orgGranted: boolean;
  /** Effective status from the credential reflection; undefined = not injected. */
  credentialStatus: CredentialAccessStatus | undefined;
  /** The organization blocks this connection entirely for this agent (from the
   * credential reflection, so it covers ATTACHED rows the per-provider probe
   * below never runs for). */
  credentialOrgBlocked: boolean;
  /** The provider has a permission catalog (Manage needs one). */
  hasCatalog: boolean;
  onManage: () => void;
}

export const ConnectionGrantRow = ({
  agentId,
  connection,
  grant,
  orgGranted,
  credentialStatus,
  credentialOrgBlocked,
  hasCatalog,
  onManage,
}: ConnectionGrantRowProps) => {
  const attach = useSetConnectionGrant();
  const detach = useDetachConnection();
  const attached = grant !== undefined;

  // Org-fully-blocked detection for UNATTACHED rows: they carry no credential,
  // so the reflection above has nothing to report on them — probe the org-only
  // ceiling over the provider-level view instead (React Query dedupes rows of
  // one provider). Attached rows get the same answer from `credentialOrgBlocked`.
  const wantCeiling = !attached && !orgGranted && hasCatalog;
  const { data: reflection } = useEffectiveAppPermissions(
    connection.provider,
    agentId,
    wantCeiling,
  );
  const tools = reflection?.groups.flatMap((g) => g.tools) ?? [];
  const orgBlocked =
    credentialOrgBlocked ||
    (wantCeiling &&
      tools.length > 0 &&
      tools.every((t) => t.orgCeiling === "block"));

  const app = getApp(connection.provider);
  const busy = attach.isPending || detach.isPending;
  // An org-blocked connection can still be DETACHED — that only removes intent,
  // and freezing it would strand the grant until the org unblocks. What it
  // can't do is grant more: attaching, and editing permissions, are off.
  const manageable = hasCatalog && (attached || orgGranted) && !orgBlocked;

  const caption = orgGranted
    ? "Granted by your organization"
    : orgBlocked
      ? "Blocked by your organization"
      : null;

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:bg-white/10 dark:border-white/10">
          {app ? (
            <AppIcon
              icon={app.icon}
              darkIcon={app.darkIcon}
              name={app.name}
              size={18}
            />
          ) : (
            <KeyRound className="text-muted-foreground size-4" aria-hidden />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {connection.label ?? app?.name ?? connection.provider}
            </span>
            {connection.scope === "organization" && (
              <Badge variant="outline" className="text-[10px] font-normal">
                Organization
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
            <span className="truncate">{app?.name ?? connection.provider}</span>
            {caption && (
              <span className="text-muted-foreground/80 shrink-0">
                {caption}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/* The switch is the status for the ordinary cases: off = unattached,
            on + working = usable. A pill appears only when it adds something
            the switch cannot — Limited, Blocked, Network only. An org block
            already reads in the caption, WITH the attribution a pill can't
            carry, so it stays the row's single status element. */}
        {!orgBlocked &&
          credentialStatus !== undefined &&
          credentialStatus !== "usable" && (
            <EffectivePill status={credentialStatus} />
          )}
        {manageable && (
          // Ghost, not outline: a tertiary action repeated on every row must
          // not out-weigh the status pills — quiet shape, full-strength text.
          <Button variant="ghost" size="xs" onClick={onManage}>
            <Settings2 className="size-3.5" />
            Manage
          </Button>
        )}
        <Switch
          size="sm"
          checked={attached || orgGranted}
          // Attaching under an org block would grant access to nothing, so the
          // ON direction is frozen; detaching stays available so an attached
          // row can still be cleaned up (see `manageable`).
          disabled={busy || orgGranted || (orgBlocked && !attached)}
          // Same fallback chain as the visible name above — the accessible
          // name must match what sighted users read (label-in-name).
          aria-label={`${attached || orgGranted ? "Detach" : "Attach"} ${connection.label ?? app?.name ?? connection.provider}`}
          onCheckedChange={(next) => {
            if (next) {
              attach.mutate({
                agentId,
                connectionId: connection.id,
                input: { access: "full" },
              });
            } else {
              detach.mutate({ agentId, connectionId: connection.id });
            }
          }}
        />
      </div>
    </div>
  );
};
