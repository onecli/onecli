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
  /** Whether "approve + always allow" is a real choice for this action. */
  offersAlwaysAllow: boolean;
  /** The asking turn's conversation, where the chat renders it inline;
   * null = bell only. */
  conversationId: string | null;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  /** Set for an agent-proposed custom connection: the card reviews it and
   * takes the key (approve goes through the dedicated route). */
  customConnection: CustomConnectionProposalView | null;
  /** Set for an agent's webhook change: the card shows the full change. */
  webhookChange: WebhookChangeView | null;
}

/** An agent's held webhook change: each field it sets, null when unchanged. */
export interface WebhookChangeView {
  name: string | null;
  instructions: string | null;
  enabled: boolean | null;
}

/** An agent-proposed custom connection as the approve card renders it.
 * Non-secret by construction: the proposal has no value field. */
export interface CustomConnectionProposalView {
  name: string;
  hostPattern: string;
  /** The owner the key is sent to: highlighted on the card. */
  registrableDomain: string | null;
  pathPattern: string | null;
  headerName: string;
  /** Contains "{value}" exactly once. */
  valueFormat: string;
  docsUrl: string | null;
  reason: string;
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
