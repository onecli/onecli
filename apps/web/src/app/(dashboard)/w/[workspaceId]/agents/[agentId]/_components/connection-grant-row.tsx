"use client";

import { getApp } from "@onecli/api/apps/registry";
import { connectionTags } from "@onecli/api/lib/connection-display";
import { KeyRound, Settings2 } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import type { AgentGrantConnection, Connection } from "@/lib/api";
import type { CredentialAccessStatus } from "@/lib/api/policy-visibility";
import { useEffectiveAppPermissions } from "@/lib/api/policy-visibility";
import {
  useDetachConnection,
  useGrantSettling,
  useSetConnectionGrant,
} from "@/hooks/use-grants";
import { AppIcon } from "@/lib/components/app-icon";
import { EffectivePill } from "./effective-pill";
import { ConnectionRowMenu } from "./connection-row-menu";

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
  /** Called before a toggle writes, so the list can keep this row where it
   * is while its state flips (no jumping out from under the pointer). */
  onBeforeToggle?: () => void;
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
  onBeforeToggle,
}: ConnectionGrantRowProps) => {
  const attach = useSetConnectionGrant();
  const detach = useDetachConnection();
  const attached = grant !== undefined;
  // The effective verdict is the server's, for the state BEFORE an in-flight
  // toggle: hidden until the toggle's refetch lands, never guessed.
  const settling = useGrantSettling(agentId, "connection", connection.id);

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
  const missingCount = connection.missingPermissions?.length ?? 0;
  // An org-blocked connection can still be DETACHED — that only removes intent,
  // and freezing it would strand the grant until the org unblocks. What it
  // can't do is grant more: attaching, and editing permissions, are off.
  // Never frozen for an in-flight write: the switch moves on click, and the
  // next click is simply the next write (they run in order).
  const manageable = hasCatalog && (attached || orgGranted) && !orgBlocked;
  const toggleDisabled = orgGranted || (orgBlocked && !attached);
  const toggle = (next: boolean) => {
    onBeforeToggle?.();
    if (next) {
      attach.mutate({
        agentId,
        connectionId: connection.id,
        input: { access: "default" },
      });
    } else {
      detach.mutate({ agentId, connectionId: connection.id });
    }
  };

  const caption = orgGranted
    ? "Granted by your organization"
    : orgBlocked
      ? "Blocked by your organization"
      : null;

  // What the connection itself reaches (e.g. a GitHub App's repos), so two
  // connections to the same account never read identically.
  const tags = connectionTags(connection.metadata);
  const reach =
    tags.length === 0
      ? null
      : tags.length <= 2
        ? tags.join(", ")
        : `${tags.slice(0, 2).join(", ")} +${tags.length - 2}`;

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
            <span className="truncate">
              {app?.name ?? connection.provider}
              {reach && (
                <span className="text-muted-foreground/80"> · {reach}</span>
              )}
            </span>
            {caption && (
              <span className="text-muted-foreground/80 shrink-0">
                {caption}
              </span>
            )}
            {missingCount > 0 && (
              <span
                className="shrink-0 text-amber-700 dark:text-amber-400"
                title={`Not granted: ${(connection.missingPermissions ?? []).map((p) => p.name).join(", ")}`}
              >
                Missing permissions
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
          !settling &&
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
        {/* Switch and its menu read as one control: tight pair. */}
        <div className="flex items-center gap-0.5">
          <Switch
            size="sm"
            checked={attached || orgGranted}
            // Attaching under an org block would grant access to nothing, so the
            // ON direction is frozen; detaching stays available so an attached
            // row can still be cleaned up (see `manageable`).
            disabled={toggleDisabled}
            // Same fallback chain as the visible name above — the accessible
            // name must match what sighted users read (label-in-name).
            aria-label={`${attached || orgGranted ? "Detach" : "Attach"} ${connection.label ?? app?.name ?? connection.provider}`}
            onCheckedChange={toggle}
          />
          <ConnectionRowMenu
            connection={connection}
            active={attached || orgGranted}
            toggleDisabled={toggleDisabled}
            onToggle={toggle}
          />
        </div>
      </div>
    </div>
  );
};
