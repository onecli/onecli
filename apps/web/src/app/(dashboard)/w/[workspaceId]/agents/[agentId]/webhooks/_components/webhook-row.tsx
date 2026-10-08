"use client";

import { Check, Copy, Pencil } from "lucide-react";
import { toast } from "sonner";
import type {
  WebhookDisabledReason,
  WebhookOutcome,
} from "@onecli/api/validations/webhooks";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Switch } from "@onecli/ui/components/switch";
import { useUpdateWebhook } from "@/hooks/use-webhooks";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { AgentWebhook } from "@/lib/api";

export interface WebhookRowProps {
  agentId: string;
  hook: AgentWebhook;
  onEdit: () => void;
}

/** The switch is the status; this badge appears only for states the switch
 * cannot express — the platform turned it off, and why. */
const DISABLED_LABEL: Record<WebhookDisabledReason, string> = {
  authorization: "Auto-disabled: creator lost access",
  failures: "Auto-disabled: kept failing",
};

const OUTCOME_LABEL: Record<WebhookOutcome, string> = {
  ok: "succeeded",
  failed: "failed",
};

const statusLabel = (hook: AgentWebhook): string => {
  if (!hook.lastReceivedAt) return "No events yet";
  const when = new Date(hook.lastReceivedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const outcome = hook.lastOutcome
    ? ` · ${OUTCOME_LABEL[hook.lastOutcome]}`
    : "";
  return `Last event ${when}${outcome}`;
};

export const WebhookRow = ({ agentId, hook, onEdit }: WebhookRowProps) => {
  const update = useUpdateWebhook(agentId);
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{hook.name}</span>
          {hook.disabledReason && (
            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
              {DISABLED_LABEL[hook.disabledReason]}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {statusLabel(hook)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Copy ${hook.name} URL`}
          onClick={() => void copy(hook.url)}
        >
          {copied ? (
            <Check className="text-brand size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy URL"}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit ${hook.name}`}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Switch
          size="sm"
          checked={hook.enabled}
          disabled={update.isPending}
          aria-label={`${hook.enabled ? "Pause" : "Resume"} ${hook.name}`}
          onCheckedChange={(next) =>
            update.mutate(
              { id: hook.id, input: { enabled: next } },
              {
                onSuccess: () =>
                  toast.success(
                    next ? `"${hook.name}" resumed` : `"${hook.name}" paused`,
                  ),
                onError: (error) => toast.error(error.message),
              },
            )
          }
        />
      </div>
    </div>
  );
};
