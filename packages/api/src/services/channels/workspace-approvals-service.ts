import { db } from "@onecli/db";
import { actionSupportsAlwaysAllow } from "./action-approval-service";
import { normalizeState } from "./agent-reach-service";
import {
  CUSTOM_CONNECTION_ACTION,
  customConnectionProposalSchema,
  registrableDomainOf,
} from "../../validations/custom-connection";
import {
  WEBHOOK_UPDATE_ACTION,
  updateWebhookArgsSchema,
} from "../../validations/webhooks";

/** An agent-proposed custom connection, as the approve card renders it.
 * Every field is non-secret by construction (the proposal has no value). */
export interface CustomConnectionProposalView {
  name: string;
  hostPattern: string;
  /** The owner the key is sent to: the card highlights it. */
  registrableDomain: string | null;
  pathPattern: string | null;
  headerName: string;
  valueFormat: string;
  docsUrl: string | null;
  reason: string;
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
    pathPattern: p.pathPattern ?? null,
    headerName: p.headerName,
    valueFormat: p.valueFormat,
    docsUrl: p.docsUrl ?? null,
    reason: p.reason,
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
  /** Whether "approve + always allow" is a real choice for this action (the
   * registry's answer, the same one the Slack card asks). False = the row
   * offers approve/reject only. */
  offersAlwaysAllow: boolean;
  /** The conversation the asking turn ran in, when the hold is anchored on
   * one: where the agent's chat renders the card inline. Null for holds
   * with no asking turn (e.g. the receiving side of a cross-workspace
   * agent message) - those live in the bell only. */
  conversationId: string | null;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  /** Set for an agent-proposed custom connection: the card renders it and
   * asks for the key (approve goes through the dedicated route). */
  customConnection: CustomConnectionProposalView | null;
  /** Set for an agent's webhook change: the card shows the full change. */
  webhookChange: WebhookChangeView | null;
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
  /** Display label captured at ask time ("#general", a person's name) —
   * may be null on old rows; the ref is the fallback the UI shows. */
  subjectLabel: string | null;
  /** The decide door's address (PUT reach/:externalRef). */
  externalRef: string;
  /** ISO timestamp. */
  createdAt: string;
}

export type PendingChannelApprovalItem =
  | PendingActionApprovalItem
  | PendingReachAskItem;

/** Oldest first: the longest-waiting ask is the one to surface. */
export const listWorkspacePendingChannelApprovals = async (
  workspaceId: string,
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
        conversationId: true,
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
        state: true,
        createdAt: true,
        agent: { select: { name: true } },
      },
    }),
  ]);

  const items: PendingChannelApprovalItem[] = [
    ...actions.map(
      (a): PendingActionApprovalItem => ({
        kind: "action",
        id: a.id,
        agentId: a.agentId,
        agentName: a.agent.name,
        summary: a.summary,
        offersAlwaysAllow: actionSupportsAlwaysAllow(a.action),
        conversationId: a.conversationId,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        customConnection: customConnectionView(a.action, a.payload),
        webhookChange: webhookChangeView(a.action, a.payload),
      }),
    ),
    ...asks
      // A row in a non-pending normalized state (legacy spellings) never
      // reaches the bell even if the raw column says otherwise.
      .filter((g) => normalizeState(g.state ?? "pending") === "pending")
      .map(
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
          createdAt: g.createdAt.toISOString(),
        }),
      ),
  ];

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
