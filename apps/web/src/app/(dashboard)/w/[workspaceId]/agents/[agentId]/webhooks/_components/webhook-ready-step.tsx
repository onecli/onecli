"use client";

import { Button } from "@onecli/ui/components/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { AgentWebhook } from "@/lib/api";
import { WebhookUrlField } from "./webhook-url-field";

/**
 * The step after a webhook is created: the URL to paste into the other app,
 * which is the only thing the user needs next. Rendered inside the create
 * dialog's frame (the dialog swaps its body to this), so there is no second
 * dialog to dismiss.
 */
export const WebhookReadyStep = ({
  hook,
  onDone,
}: {
  hook: AgentWebhook;
  onDone: () => void;
}) => (
  <>
    <DialogHeader>
      <DialogTitle>Webhook ready</DialogTitle>
      <DialogDescription>
        Paste this URL into the app that should trigger the agent, where it asks
        for a webhook or endpoint URL.
      </DialogDescription>
    </DialogHeader>
    <DialogBody className="space-y-2">
      <WebhookUrlField url={hook.url} />
      <p className="text-muted-foreground text-xs">
        Anyone with this URL can trigger the agent, so treat it like a password.
        Each event runs in its own conversation and reports back to your chat.
      </p>
    </DialogBody>
    <DialogFooter>
      <Button onClick={onDone}>Done</Button>
    </DialogFooter>
  </>
);
