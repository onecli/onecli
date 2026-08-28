"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { cn } from "@onecli/ui/lib/utils";

/**
 * The agent's mark, PURE: its uploaded avatar when one exists, the shared
 * `AgentIcon` glyph otherwise. No data hooks — sidebar rows render dozens of
 * these; the upload/remove door is `AgentAvatarEditor`, which wraps this.
 */
export const AgentAvatar = ({
  agent,
  pending = false,
  className,
}: {
  agent: { name: string; imageUrl?: string | null };
  /** The editor's in-flight signal — swaps the face for a spinner. */
  pending?: boolean;
  className?: string;
}) => {
  // The one URL that failed to load — a broken image falls back to the
  // glyph instead of the browser's broken-image mark, and a replacement
  // (which rotates the key, so a NEW url) retries automatically.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const imageUrl =
    agent.imageUrl && agent.imageUrl !== brokenUrl ? agent.imageUrl : null;

  return (
    // Color lives on the FRAME (muted by default) so the glyph/spinner
    // inherit — a consumer like the sidebar row overrides with text-current
    // and its active-state tint reaches the glyph, exactly like sibling nav
    // icons.
    <div
      className={cn(
        "bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border",
        className,
      )}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : imageUrl ? (
        // Plain <img>, not next/image: the source is the API origin
        // (key-fenced, cache-busted by key rotation) and the optimizer would
        // just proxy it. Decorative on purpose — every consumer sits beside
        // the agent's visible name, so an alt would double-announce it. No
        // radius of its own: the frame's overflow-hidden clips it to WHATEVER
        // corner the consumer chose (rounded-sm in the sidebar).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          aria-hidden
          data-testid="agent-avatar-image"
          className="size-full object-cover"
          onError={() => setBrokenUrl(imageUrl)}
        />
      ) : (
        <AgentIcon className="size-4" aria-hidden />
      )}
    </div>
  );
};
