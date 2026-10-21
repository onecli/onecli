"use client";

import type { WebhookChangeView } from "@/lib/api/channel-approvals";

export interface WebhookChangePreviewProps {
  change: WebhookChangeView;
}

/**
 * The full change an agent asked to make to a webhook, inside its approve
 * card. The summary line above is clamped, and instructions are what every
 * future event runs under, so the person reads all of them before deciding.
 * Model-written text, rendered as text only.
 */
export const WebhookChangePreview = ({ change }: WebhookChangePreviewProps) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
    {change.name !== null && (
      <>
        <dt className="text-muted-foreground">New name</dt>
        <dd className="min-w-0 break-words">{change.name}</dd>
      </>
    )}
    {change.enabled !== null && (
      <>
        <dt className="text-muted-foreground">State</dt>
        <dd>{change.enabled ? "Turn on" : "Pause"}</dd>
      </>
    )}
    {change.instructions !== null && (
      <>
        <dt className="text-muted-foreground">New instructions</dt>
        <dd
          // Focusable so a keyboard user can scroll long instructions.
          tabIndex={0}
          aria-label="New instructions"
          className="bg-muted/50 focus-visible:ring-ring max-h-48 min-w-0 overflow-y-auto overscroll-contain rounded-md p-2 break-words whitespace-pre-wrap focus-visible:ring-2 focus-visible:outline-none"
        >
          {change.instructions}
        </dd>
      </>
    )}
  </dl>
);
