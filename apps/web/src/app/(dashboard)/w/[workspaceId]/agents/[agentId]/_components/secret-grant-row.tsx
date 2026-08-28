"use client";

import { KeyRound, Pencil } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import type { Secret } from "@/lib/api";
import type { CredentialAccessStatus } from "@/lib/api/policy-visibility";
import { useAttachSecret, useDetachSecret } from "@/hooks/use-grants";
import { EffectivePill } from "./effective-pill";
import { KeyHealthBadge } from "./key-health-badge";

interface SecretGrantRowProps {
  agentId: string;
  secret: Secret;
  /** Attached through a workspace grant (the grants API). */
  granted: boolean;
  /** Injected via an ORG rule (locked on — not detachable at workspace level). */
  orgGranted: boolean;
  credentialStatus: CredentialAccessStatus | undefined;
  /** Open the edit dialog for this secret. Omitted where editing has no home
   *  (the Connections section's generic tab keeps its own management page). */
  onEdit?: (secret: Secret) => void;
}

export const SecretGrantRow = ({
  agentId,
  secret,
  granted,
  orgGranted,
  credentialStatus,
  onEdit,
}: SecretGrantRowProps) => {
  const attach = useAttachSecret();
  const detach = useDetachSecret();
  const busy = attach.isPending || detach.isPending;

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:bg-white/10 dark:border-white/10">
          <KeyRound className="text-muted-foreground size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{secret.name}</span>
            <Badge variant="secondary" className="text-[10px] font-normal">
              {secret.typeLabel}
            </Badge>
            {secret.scope === "organization" && (
              <Badge variant="outline" className="text-[10px] font-normal">
                Organization
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="truncate font-mono">{secret.hostPattern}</span>
            {orgGranted && (
              <span className="text-muted-foreground/80 shrink-0">
                Granted by your organization
              </span>
            )}
            {secret.lastError && (
              <KeyHealthBadge type={secret.type} lastError={secret.lastError} />
            )}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/* The switch is the status for the ordinary cases: off = unattached,
            on + working = usable. A pill appears only when it adds something
            the switch cannot — Limited, Blocked, Network only. */}
        {credentialStatus !== undefined && credentialStatus !== "usable" && (
          <EffectivePill status={credentialStatus} />
        )}
        {onEdit && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit ${secret.name}`}
            onClick={() => onEdit(secret)}
          >
            <Pencil className="size-4" aria-hidden />
          </Button>
        )}
        <Switch
          size="sm"
          checked={granted || orgGranted}
          disabled={busy || orgGranted}
          aria-label={`${granted || orgGranted ? "Detach" : "Attach"} ${secret.name}`}
          onCheckedChange={(next) => {
            if (next) {
              attach.mutate({ agentId, secretId: secret.id });
            } else {
              detach.mutate({ agentId, secretId: secret.id });
            }
          }}
        />
      </div>
    </div>
  );
};
