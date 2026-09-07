// The approvals bell's CHANNEL arm (4d) — pending action approvals and
// reach asks across the active workspace, via the typed JSON API (unlike
// the gateway-direct tool-approval list in ./approvals.ts).
import { apiGet } from "./client";

export interface PendingActionApprovalItem {
  kind: "action";
  id: string;
  agentId: string;
  agentName: string;
  summary: string;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
}

export interface PendingReachAskItem {
  kind: "reach";
  id: string;
  agentId: string;
  agentName: string;
  provider: string;
  /** "space" = a channel (three-way decision); "external_user" = a person
   * (two-way). */
  subjectKind: "space" | "external_user";
  subjectLabel: string | null;
  /** The decide door's address (PUT reach/:externalRef). */
  externalRef: string;
  /** ISO timestamp. */
  createdAt: string;
}

export type PendingChannelApprovalItem =
  | PendingActionApprovalItem
  | PendingReachAskItem;

/** Age-sorted (oldest first), workspace-fenced server-side. */
export const listPendingChannelApprovals = (workspaceId: string) =>
  apiGet<{ items: PendingChannelApprovalItem[] }>(
    `/v1/workspaces/${workspaceId}/channel-approvals`,
  ).then((r) => r.items);
