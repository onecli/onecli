"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { AppIcon } from "@/lib/components/app-icon";
import {
  SLACK_DISPLAY_NAME,
  SLACK_ICON_SRC,
} from "@/lib/agents/slack-presence";

export interface SlackAppIconProps {
  /** The app's PROFILE icon as last read from Slack; null = Slack's stock
   * mark, so the Slack logo stands in. */
  iconUrl?: string | null;
  /** Slack's "Display Information" card for this app, where the icon is
   * set. */
  editUrl: string;
}

/**
 * The attached card's face: the Slack app's OWN icon (what Slack shows in its
 * sidebar), with a pencil that opens the page where it is changed. Once
 * changed there, "Sync image" copies it onto the agent's image.
 */
export const SlackAppIcon = ({ iconUrl, editUrl }: SlackAppIconProps) => {
  // Keyed by URL: a dead CDN URL falls back to the Slack logo, and the next
  // sync's new URL gets its own chance to load.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const face =
    iconUrl && iconUrl !== brokenUrl ? (
      // Plain <img>: a Slack CDN URL the optimizer would only proxy.
      // Decorative, the app's handle sits right beside it.
      <img
        src={iconUrl}
        alt=""
        aria-hidden
        width={40}
        height={40}
        className="size-full object-cover"
        onError={() => setBrokenUrl(iconUrl)}
      />
    ) : (
      <AppIcon icon={SLACK_ICON_SRC} name={SLACK_DISPLAY_NAME} size={22} />
    );

  return (
    <a
      href={editUrl}
      target="_blank"
      rel="noreferrer"
      aria-label="Change the Slack app icon"
      title="Change the Slack app icon"
      className="focus-visible:ring-ring group relative shrink-0 rounded-xl focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="bg-card flex size-10 items-center justify-center overflow-hidden rounded-xl border shadow-sm">
        {face}
      </span>
      <span className="bg-card text-muted-foreground group-hover:text-foreground absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full border shadow-sm transition-colors">
        <Pencil className="size-3" aria-hidden />
      </span>
    </a>
  );
};
