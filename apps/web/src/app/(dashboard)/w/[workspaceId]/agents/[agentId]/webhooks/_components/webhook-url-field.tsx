"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * The webhook URL with a one-click copy: the thing the user pastes into the
 * other app. Read-only and select-on-focus, so a drag or a Cmd-C grabs the
 * whole thing; the copy button's icon flips to a check as the feedback (the
 * house copy pattern — no toast on top of it).
 */
export const WebhookUrlField = ({ url }: { url: string }) => {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={url}
        aria-label="Webhook URL"
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        variant="outline"
        size="icon"
        aria-label="Copy webhook URL"
        onClick={() => void copy(url)}
      >
        {copied ? (
          <Check className="text-brand size-4" />
        ) : (
          <Copy className="size-4" />
        )}
      </Button>
    </div>
  );
};
