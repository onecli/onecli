"use client";

import { useState } from "react";
import { Loader2, Plus, Webhook } from "lucide-react";
import { MAX_WEBHOOKS_PER_AGENT } from "@onecli/api/validations/webhooks";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { useWebhooks } from "@/hooks/use-webhooks";
import type { AgentWebhook } from "@/lib/api";
import { WebhookRow } from "./webhook-row";
import { WebhookDialog } from "./webhook-dialog";

/**
 * The agent's Webhooks section (plans/agent-webhooks.md): URLs an external
 * app calls to trigger this agent, each with its own instructions. Reports
 * land in the chat the webhook was created from, like Schedules, so this is
 * the MANAGEMENT surface only: rows, the pause switch, the create/edit
 * dialog.
 */
export const WebhooksSection = () => {
  const agent = useAgentPageAgent();
  const view = useWebhooks(agent.id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentWebhook | null>(null);

  const open = (hook: AgentWebhook | null) => {
    setEditing(hook);
    setDialogOpen(true);
  };

  if (view.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Loader2
          className="text-muted-foreground size-5 animate-spin"
          aria-hidden
        />
        <span className="sr-only">Loading webhooks</span>
      </div>
    );
  }

  // Never render toggle rows over a failed load — a blind toggle would write
  // against invisible state (the apps-tab law).
  if (view.isError) {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm"
      >
        Webhooks failed to load. Refresh to try again.
      </div>
    );
  }

  const hooks = view.data.webhooks;
  // The server refuses past the cap; saying so here beats a toast after the
  // click.
  const atCap = hooks.length >= MAX_WEBHOOKS_PER_AGENT;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Webhooks</h2>
          <p className="text-muted-foreground text-sm">
            Let another app trigger this agent. Paste the URL into that app and
            describe what the agent should do with each event. Each run reports
            back to your chat.
          </p>
        </div>
        {hooks.length > 0 && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button size="sm" onClick={() => open(null)} disabled={atCap}>
              <Plus className="size-4" />
              New webhook
            </Button>
            {atCap && (
              <p className="text-muted-foreground text-xs">
                Up to {MAX_WEBHOOKS_PER_AGENT} per agent
              </p>
            )}
          </div>
        )}
      </div>

      {hooks.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <Webhook className="text-muted-foreground size-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium">No webhooks yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              For example: when a meeting ends, your notes app sends the summary
              and the agent files the action items.
            </p>
          </div>
          <Button size="sm" onClick={() => open(null)}>
            <Plus className="size-4" />
            New webhook
          </Button>
        </Card>
      ) : (
        <div className="divide-y rounded-md border">
          {hooks.map((hook) => (
            <WebhookRow
              key={hook.id}
              agentId={agent.id}
              hook={hook}
              onEdit={() => open(hook)}
            />
          ))}
        </div>
      )}

      <WebhookDialog
        agentId={agent.id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />
    </div>
  );
};
