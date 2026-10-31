"use client";

import dynamic from "next/dynamic";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { CustomConnectionApprovalRow } from "./custom-connection-approval-row";
import { GenericActionApprovalRow } from "./generic-action-approval-row";
import { ContactBlockedCard } from "./contact-blocked-card";
import { ChooseSenderCard } from "./choose-sender-card";

// "Act as you in Slack" access requests (licensed: granular_access). Lazy,
// so the licensed card never enters the free bundle's static graph; the
// server only lists such requests when the instance is entitled.
const SlackAccessCard = dynamic(() =>
  import("@/ee/slack-read/slack-access-card").then((m) => m.SlackAccessCard),
);

interface ActionApprovalRowProps {
  item: PendingActionApprovalItem;
}

/**
 * One pending action approval (bell and inline chat). An agent-proposed
 * custom connection needs the key typed in, so it gets its own card and its
 * own approve door. A row whose payload no longer validates
 * (customConnection null) falls back to the generic row, whose approve the
 * server refuses for that action, so decline still works. A Slack access
 * request gets its Connect / Allow card.
 */
export const ActionApprovalRow = ({ item }: ActionApprovalRowProps) => {
  const { customConnection, slackAccess, contactBlocked, chooseSender } = item;
  if (customConnection) {
    return <CustomConnectionApprovalRow item={{ ...item, customConnection }} />;
  }
  if (slackAccess) {
    return <SlackAccessCard item={{ ...item, slackAccess }} />;
  }
  if (contactBlocked) {
    return <ContactBlockedCard item={{ ...item, contactBlocked }} />;
  }
  if (chooseSender) {
    return <ChooseSenderCard item={{ ...item, chooseSender }} />;
  }
  return <GenericActionApprovalRow item={item} />;
};
