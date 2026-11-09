"use client";

import { InviteButton } from "@/lib/team/_components/invite-button";
import { useOrgMembership } from "@/hooks/use-org";

/**
 * Invite someone to the organization, as an icon between the agent's menu
 * and the bell. Admins only (the Members page gates its Invite the same
 * way); until the membership read answers, nothing is drawn, so the bar
 * never shows a control it then takes away.
 */
export const InviteIcon = () => {
  const { data: membership } = useOrgMembership();
  if (!membership?.isAdmin) return null;
  return <InviteButton variant="icon" />;
};
