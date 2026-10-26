"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@onecli/ui/components/avatar";
import type { SlackProfile } from "./api";

export interface SlackIdentityProps {
  profile: SlackProfile | null;
}

const initials = (profile: SlackProfile | null): string => {
  const source = profile?.realName || profile?.handle || "";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "S"
  );
};

/**
 * Who your Slack is connected as: avatar, full name, @handle and email, so
 * you can see at a glance it is the right account. Every field degrades:
 * no avatar shows initials, no name shows the handle.
 */
export const SlackIdentity = ({ profile }: SlackIdentityProps) => {
  const name = profile?.realName || profile?.handle || "Your Slack";
  const secondary = [
    profile?.handle && profile.handle !== name ? `@${profile.handle}` : null,
    profile?.email,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className="size-9 shrink-0">
        {profile?.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="" />}
        <AvatarFallback className="text-xs">{initials(profile)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium" translate="no">
          {name}
        </p>
        {secondary && (
          <p className="text-muted-foreground truncate text-xs" translate="no">
            {secondary}
          </p>
        )}
      </div>
    </div>
  );
};
