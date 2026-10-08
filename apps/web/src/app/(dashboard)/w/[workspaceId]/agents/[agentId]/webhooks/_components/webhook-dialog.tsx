"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  WEBHOOK_INSTRUCTIONS_MAX_LENGTH,
  WEBHOOK_NAME_MAX_LENGTH,
} from "@onecli/api/validations/webhooks";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Textarea } from "@onecli/ui/components/textarea";
import {
  useCreateWebhook,
  useDeleteWebhook,
  useUpdateWebhook,
} from "@/hooks/use-webhooks";
import type { AgentWebhook } from "@/lib/api";
import { WebhookReadyStep } from "./webhook-ready-step";
import { WebhookUrlField } from "./webhook-url-field";

export interface WebhookDialogProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create. */
  editing: AgentWebhook | null;
}

/**
 * Create/edit a webhook: a name and what to do with each event. One dialog
 * frame; on create its body becomes the "paste this URL" step
 * (`WebhookReadyStep`) instead of closing, because that URL is the only
 * thing the user needs next.
 */
export const WebhookDialog = ({
  agentId,
  open,
  onOpenChange,
  editing,
}: WebhookDialogProps) => {
  const create = useCreateWebhook(agentId);
  const update = useUpdateWebhook(agentId);
  const remove = useDeleteWebhook(agentId);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [created, setCreated] = useState<AgentWebhook | null>(null);

  // Re-seed the form whenever the dialog opens on a different target.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setInstructions(editing?.instructions ?? "");
    setCreated(null);
  }, [open, editing]);

  const busy = create.isPending || update.isPending || remove.isPending;
  const onError = (error: Error) => toast.error(error.message);
  const close = () => onOpenChange(false);

  const submit = () => {
    const input = { name: name.trim(), instructions: instructions.trim() };
    if (editing) {
      update.mutate(
        { id: editing.id, input },
        {
          onSuccess: () => {
            toast.success("Webhook updated");
            close();
          },
          onError,
        },
      );
    } else {
      create.mutate(input, { onSuccess: setCreated, onError });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The FRAME is fixed and the fields scroll inside it (the cron dialog's
          layout): instructions can be a whole runbook, and a dialog that grows
          with them would carry its own Save button off-screen. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md">
        {created ? (
          <WebhookReadyStep hook={created} onDone={close} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit webhook" : "New webhook"}
              </DialogTitle>
              <DialogDescription>
                Another app calls this webhook, and the agent follows your
                instructions with the event it sends.
              </DialogDescription>
            </DialogHeader>

            {/* `-m-1 p-1` buys the scroll box a 4px gutter so an edge field's
                focus ring is not shaved off by `overflow-y-auto`. */}
            <DialogBody className="-m-1 space-y-4 p-1">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-name">Name</Label>
                <Input
                  id="webhook-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Meeting notes"
                  maxLength={WEBHOOK_NAME_MAX_LENGTH}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="webhook-instructions">
                  What should it do with each event?
                </Label>
                <Textarea
                  id="webhook-instructions"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="A meeting just ended. Create an issue for each action item assigned to me, and send me a 3-line summary."
                  rows={4}
                  // `field-sizing-content` grows this field with what you
                  // type, so it needs its own ceiling inside the scroll box.
                  className="max-h-[min(18rem,32dvh)]"
                  maxLength={WEBHOOK_INSTRUCTIONS_MAX_LENGTH}
                />
              </div>
              {editing && (
                <div className="space-y-1.5">
                  <Label>URL</Label>
                  <WebhookUrlField url={editing.url} />
                </div>
              )}
            </DialogBody>

            <DialogFooter className="gap-2 sm:justify-between">
              {editing ? (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  loading={remove.isPending}
                  onClick={() =>
                    remove.mutate(editing.id, {
                      onSuccess: () => {
                        toast.success("Webhook deleted");
                        close();
                      },
                      onError,
                    })
                  }
                >
                  Delete
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="outline" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button
                  disabled={busy || !name.trim() || !instructions.trim()}
                  loading={create.isPending || update.isPending}
                  onClick={submit}
                >
                  {editing ? "Save" : "Create"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
