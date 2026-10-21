"use client";

import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { CustomConnectionApprovalRow } from "./custom-connection-approval-row";
import { GenericActionApprovalRow } from "./generic-action-approval-row";

interface ActionApprovalRowProps {
  item: PendingActionApprovalItem;
}

/**
 * One pending action approval (bell and inline chat). An agent-proposed
 * custom connection needs the key typed in, so it gets its own card and its
 * own approve door. A row whose payload no longer validates
 * (customConnection null) falls back to the generic row, whose approve the
 * server refuses for that action, so decline still works.
 */
export const ActionApprovalRow = ({ item }: ActionApprovalRowProps) => {
  const { customConnection } = item;
  if (customConnection) {
    return <CustomConnectionApprovalRow item={{ ...item, customConnection }} />;
  }
  return <GenericActionApprovalRow item={item} />;
};
