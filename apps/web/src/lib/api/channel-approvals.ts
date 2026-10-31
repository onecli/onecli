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
  /** A standing question about who the agent wants to reach: the only
   * answers are Always allow and Never. */
  standingChoice: boolean;
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
  /** Set for a "let the agent act as you in Slack" request (licensed):
   * the chat renders a Connect or Allow card from it. */
  slackAccess?: SlackAccessView | null;
  /** Set for a send refused by a blocked contact: Allow / Don't
   * send. */
  contactBlocked?: ContactBlockedView | null;
  /** Set for "send as the agent or as you?": one button per sender. */
  chooseSender?: ChooseSenderView | null;
}

export interface ChooseSenderView {
  recipientLabel: string;
  text: string;
  agentName: string;
}

export interface ContactBlockedView {
  recipientLabel: string;
}

/** A Slack access request: what the card offers. Not-connected and
 * reconnect-for-write resolve by connecting; the rest by Allow. */
export interface SlackAccessView {
  kind: "read" | "write";
  reason: "not_connected" | "not_shared" | "write_off" | "reconnect_for_write";
  conversationLabel: string | null;
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
  /** The provider tenant the subject lives in (Slack: the team id), for the
   * channel link in Details. Absent on older servers. */
  tenantExternalId?: string;
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

/** The bell's channel items. A Slack connect request (not connected /
 * reconnect for write) is only actionable by the asker in their own chat:
 * it renders there as a card and never in the bell. */
export const bellChannelApprovals = (items: PendingChannelApprovalItem[]) =>
  items.filter(
    (item) =>
      item.kind !== "action" ||
      (item.slackAccess?.reason !== "not_connected" &&
        item.slackAccess?.reason !== "reconnect_for_write"),
  );
