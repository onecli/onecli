"use client";

import { KeyRound } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Switch } from "@onecli/ui/components/switch";
import type { Secret } from "@/lib/api";
import type { CredentialAccessStatus } from "@/lib/api/policy-visibility";
import { useAttachSecret, useDetachSecret } from "@/hooks/use-grants";
import { EffectivePill } from "./effective-pill";

interface SecretGrantRowProps {
  agentId: string;
  secret: Secret;
  /** Attached through a project grant (the grants API). */
  granted: boolean;
  /** Injected via an ORG rule (locked on — not detachable at project level). */
  orgGranted: boolean;
  credentialStatus: CredentialAccessStatus | undefined;
}

export const SecretGrantRow = ({
  agentId,
  secret,
  granted,
  orgGranted,
  credentialStatus,
}: SecretGrantRowProps) => {
  const attach = useAttachSecret();
  const detach = useDetachSecret();
  const busy = attach.isPending || detach.isPending;

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border">
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
          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
            <span className="truncate font-mono">{secret.hostPattern}</span>
            {orgGranted && (
              <span className="text-muted-foreground/80 shrink-0">
                Granted by your organization
              </span>
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
