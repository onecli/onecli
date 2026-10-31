"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@onecli/ui/components/avatar";
import { getInitials } from "@/lib/user-display";

export interface PersonAvatarProps {
  name: string;
  /** Their provider profile photo (https), when known. */
  imageUrl: string | null;
}

/**
 * A person's mark on a Contacts row, framed like an agent's (`AgentAvatar`)
 * so the groups read as one list: their photo when there is one, their
 * initials otherwise (and when the photo fails to load). Decorative: the
 * name sits right beside it.
 */
export const PersonAvatar = ({ name, imageUrl }: PersonAvatarProps) => (
  <Avatar className="size-8 rounded-lg border" aria-hidden>
    {imageUrl ? (
      <AvatarImage src={imageUrl} alt="" className="object-cover" />
    ) : null}
    <AvatarFallback className="rounded-lg text-xs" translate="no">
      {getInitials(name.trim() || null, null)}
    </AvatarFallback>
  </Avatar>
);
