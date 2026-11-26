import { db, type Prisma } from "@onecli/db";
import { isStandingChoice, isVisibleTo } from "./action-approval-service";
import {
  CUSTOM_CONNECTION_ACTION,
  customConnectionProposalSchema,
  registrableDomainOf,
} from "../../validations/custom-connection";
import {
  SLACK_ACCESS_ACTION,
  slackAccessPayloadSchema,
  type SlackAccessReason,
} from "../../validations/slack-access";
import {
  CONTACT_BLOCKED_ACTION,
  contactBlockedPayloadOf,
} from "./send-message-service";
import {
  CHOOSE_SENDER_ACTION,
  chooseSenderPayloadOf,
} from "./choose-sender-service";
import {
  WEBHOOK_UPDATE_ACTION,
  updateWebhookArgsSchema,
} from "../../validations/webhooks";

/** An agent-proposed custom connection, as the approve card renders it:
 * the name and where the key goes, nothing else. The proposal's docs link,
 * reason and header shape stay in the frozen payload, so no agent-chosen
 * link or prose ever reaches the card. */
export interface CustomConnectionProposalView {
  name: string;
  hostPattern: string;
  /** The owner the key is sent to: the card names it. */
  registrableDomain: string | null;
}

/** The structured view of a custom-connection payload, or null when the
 * row is another action or its payload no longer validates (the bell then
 * shows the generic row, where only decline goes through). */
const customConnectionView = (
  action: string,
  payload: unknown,
): CustomConnectionProposalView | null => {
  if (action !== CUSTOM_CONNECTION_ACTION) return null;
  const parsed = customConnectionProposalSchema.safeParse(payload);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    name: p.name,
    hostPattern: p.hostPattern,
    registrableDomain: registrableDomainOf(p.hostPattern),
  };
};

/** An agent's held webhook change, as the approve card renders it: the full
 * text, since the one-line summary is clamped. */
export interface WebhookChangeView {
  name: string | null;
  instructions: string | null;
  enabled: boolean | null;
}

/** The structured view of a webhook-change payload, or null for another
 * action or a payload that no longer validates (the generic row then). */
const webhookChangeView = (
  action: string,
  payload: unknown,
): WebhookChangeView | null => {
  if (action !== WEBHOOK_UPDATE_ACTION) return null;
  const parsed = updateWebhookArgsSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    name: parsed.data.name ?? null,
    instructions: parsed.data.instructions ?? null,
    enabled: parsed.data.enabled ?? null,
  };
};

/** A "let the agent act as you in Slack" request, as the chat card renders
 * it (no message text: the summary carries what the card says). */
export interface SlackAccessView {
  kind: "read" | "write";
  reason: SlackAccessReason;
  conversationLabel: string | null;
}

const slackAccessView = (
  action: string,
  payload: unknown,
): SlackAccessView | null => {
  if (action !== SLACK_ACCESS_ACTION) return null;
  const parsed = slackAccessPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    kind: parsed.data.kind,
    reason: parsed.data.reason,
    conversationLabel:
      parsed.data.conversationLabel ?? parsed.data.conversationQuery,
  };
};

/** A send refused by a blocked contact, raised in the asking person's own
 * chat: Allow / Don't send. */
export interface ContactBlockedView {
  recipientLabel: string;
}

const contactBlockedView = (
  action: string,
  payload: Prisma.JsonValue,
): ContactBlockedView | null => {
  if (action !== CONTACT_BLOCKED_ACTION) return null;
  try {
    const p = contactBlockedPayloadOf(payload);
    return { recipientLabel: p.to.label };
  } catch {
    return null;
  }
};

/** "Send as the agent or as you?": the card's preview and buttons. */
export interface ChooseSenderView {
  recipientLabel: string;
  text: string;
  agentName: string;
}

const chooseSenderView = (
  action: string,
  payload: Prisma.JsonValue,
): ChooseSenderView | null => {
  if (action !== CHOOSE_SENDER_ACTION) return null;
  try {
    const p = chooseSenderPayloadOf(payload);
    return {
      recipientLabel: p.recipient.label,
      text: p.text,
      agentName: p.agentName,
    };
  } catch {
    return null;
  }
};

/**
 * The approvals bell's CHANNEL arm (4d): every channel decision waiting on a
 * human in one workspace — pending one-shot action approvals and pending
 * reach asks — as one age-sorted list. The bell is the ONE decide surface
 * for these (the channels page keeps settled-state settings only), so this
 * listing carries everything a row and its decide dialog need; deciding
 * itself stays on the existing per-agent doors.
 *
 * Workspace-fenced at the query, both arms — a foreign workspace reads [].
 */

export interface PendingActionApprovalItem {
  kind: "action";
  id: string;
  agentId: string;
  agentName: string;
  summary: string;
  /** The only answers are Always allow / Never: a standing question about
   * who the agent wants to reach, never a one-off (the registry's answer,
   * the same one the Slack card asks). */
  standingChoice: boolean;
  /** The conversation the agent's chat renders the card inline in: the
   * asking turn's, or for a scheduled run, process watch or webhook the
   * chat it reports to (its own conversation is rendered nowhere). Null
   * for holds with no asking turn (e.g. the receiving side of a
   * cross-workspace agent message). */
  conversationId: string | null;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  /** Set for an agent-proposed custom connection: the card renders it and
   * asks for the key (approve goes through the dedicated route). */
  customConnection: CustomConnectionProposalView | null;
  /** Set for an agent's webhook change: the card shows the full change. */
  webhookChange: WebhookChangeView | null;
  /** Set for a Slack access request (read_conversation / send_as_me
   * needs_access): the chat renders a Connect or Allow card. */
  slackAccess: SlackAccessView | null;
  /** Set for a blocked contact's card (Allow / Don't send). */
  contactBlocked: ContactBlockedView | null;
  /** Set for a choose-sender card (As <Agent> / As me / Don't send). */
  chooseSender: ChooseSenderView | null;
}

export interface PendingReachAskItem {
  kind: "reach";
  id: string;
  agentId: string;
  agentName: string;
  provider: string;
  /** "space" = a channel (Everyone / Nobody); "external_user" = a person
   * (Always allow / Never). */
  subjectKind: "space" | "external_user";
  /** Display label captured at ask time ("#general", a person's name) —
   * may be null on old rows; the ref is the fallback the UI shows. */
  subjectLabel: string | null;
  /** The decide door's address (PUT reach/:externalRef). */
  externalRef: string;
  /** The provider tenant the subject lives in (Slack: the team id), so the
   * bell can link to the channel. Not a secret: the same id backs the
   * agent's "Open in Slack" link. */
  tenantExternalId: string;
  /** ISO timestamp. */
  createdAt: string;
}

export type PendingChannelApprovalItem =
  | PendingActionApprovalItem
  | PendingReachAskItem;

/** A held approval's anchor, as the reporting-chat lookup reads it. */
interface ApprovalAnchor {
  /** The agent that asked: the only agent whose chat may show it. */
  agentId: string;
  conversation: { id: string; source: string; externalRef: string | null };
}

const ORIGIN_SELECT = {
  id: true,
  originConversation: { select: { id: true, agentId: true } },
} as const;

/**
 * Each automation source whose runs get a conversation of their own
 * (`externalRef` = the automation's id), and how to find the chat that
 * automation was created from, where its reports land.
 */
const AUTOMATION_ORIGINS = {
  cron: (ids: string[]) =>
    db.agentCron.findMany({
      where: { id: { in: ids } },
      select: ORIGIN_SELECT,
    }),
  watch: (ids: string[]) =>
    db.processWatch.findMany({
      where: { id: { in: ids } },
      select: ORIGIN_SELECT,
    }),
  webhook: (ids: string[]) =>
    db.agentWebhook.findMany({
      where: { id: { in: ids } },
      select: ORIGIN_SELECT,
    }),
};

/**
 * Where each automation run's conversation reports. A scheduled run, a
 * process watch or a webhook runs in a conversation no chat renders, and
 * delivers to the chat it was created from; a hold it raised shows there
 * too, where its owner will see it. Only a report chat of the agent that
 * asked counts: a client can mint a conversation with any source and ref,
 * and it must never borrow another agent's chat. Every other conversation
 * keeps its own id. One query per automation kind present.
 */
const reportingChatsFor = async (
  anchors: readonly ApprovalAnchor[],
): Promise<Map<string, string>> => {
  const found = await Promise.all(
    Object.entries(AUTOMATION_ORIGINS).map(async ([source, findOrigins]) => {
      const refs = new Set(
        anchors.flatMap(({ conversation: c }) =>
          c.source === source && c.externalRef ? [c.externalRef] : [],
        ),
      );
      if (refs.size === 0) return [];
      const rows = await findOrigins([...refs]);
      return rows.map(
        (row) => [`${source}:${row.id}`, row.originConversation] as const,
      );
    }),
  );
  const origins = new Map(found.flat());
  const reportsTo = new Map<string, string>();
  for (const { agentId, conversation: c } of anchors) {
    const to = origins.get(`${c.source}:${c.externalRef}`);
    if (to?.agentId === agentId) reportsTo.set(c.id, to.id);
  }
  return reportsTo;
};

/** Oldest first: the longest-waiting ask is the one to surface. */
export const listWorkspacePendingChannelApprovals = async (
  workspaceId: string,
  /** The person looking. A PERSONAL ask ("act as you in Slack") is theirs
   * alone to decide, so it shows only to them; omitted = no personal asks. */
  viewerUserId?: string,
): Promise<PendingChannelApprovalItem[]> => {
  const [actions, asks] = await Promise.all([
    db.actionApproval.findMany({
      where: {
        status: "pending",
        expiresAt: { gt: new Date() },
        agent: { workspaceId },
      },
      select: {
        id: true,
        agentId: true,
        action: true,
        payload: true,
        summary: true,
        conversation: {
          select: { id: true, source: true, externalRef: true },
        },
        createdAt: true,
        expiresAt: true,
        agent: { select: { name: true } },
      },
    }),
    db.agentReachGrant.findMany({
      where: { state: "pending", agent: { workspaceId } },
      select: {
        id: true,
        agentId: true,
        provider: true,
        subjectKind: true,
        subjectLabel: true,
        externalRef: true,
        createdAt: true,
        agent: { select: { name: true } },
        integration: { select: { externalId: true } },
      },
    }),
  ]);

  const visibleActions = actions.filter((a) =>
    isVisibleTo(a.action, a.payload, viewerUserId),
  );
  const reportsTo = await reportingChatsFor(
    visibleActions.flatMap(({ agentId, conversation }) =>
      conversation ? [{ agentId, conversation }] : [],
    ),
  );
  const items: PendingChannelApprovalItem[] = [
    ...visibleActions.map(
      (a): PendingActionApprovalItem => ({
        kind: "action",
        id: a.id,
        agentId: a.agentId,
        agentName: a.agent.name,
        summary: a.summary,
        standingChoice: isStandingChoice(a.action),
        conversationId: a.conversation
          ? (reportsTo.get(a.conversation.id) ?? a.conversation.id)
          : null,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        customConnection: customConnectionView(a.action, a.payload),
        webhookChange: webhookChangeView(a.action, a.payload),
        slackAccess: slackAccessView(a.action, a.payload),
        contactBlocked: contactBlockedView(a.action, a.payload),
        chooseSender: chooseSenderView(a.action, a.payload),
      }),
    ),
    ...asks.map(
      (g): PendingReachAskItem => ({
        kind: "reach",
        id: g.id,
        agentId: g.agentId,
        agentName: g.agent.name,
        provider: g.provider,
        subjectKind:
          g.subjectKind === "external_user" ? "external_user" : "space",
        subjectLabel: g.subjectLabel,
        externalRef: g.externalRef,
        tenantExternalId: g.integration.externalId,
        createdAt: g.createdAt.toISOString(),
      }),
    ),
  ];

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
