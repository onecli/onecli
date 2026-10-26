import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  AUDIT_STATUS,
  recordAuditEvent,
} from "./audit-service";
import { ensureWorkspaceApiKey } from "./api-key-service";
import { writeConversationNotice } from "./conversation-notice";
import { resolveLlmCallKey } from "./llm-direct-call";
import { judgeSupersede } from "./judges/supersede-judge";
import {
  decideApprovalAtGateway,
  listPendingApprovalsAtGateway,
  type GatewayPendingApproval,
} from "./channels/gateway-approvals";
import { rewriteGatewayApprovalCards } from "./channels/gateway-approval-card";
import type { TurnOrigin } from "./turn-service";
import { ACTIVE_TURN_STATUSES } from "../validations/conversation";

const log = logger.child({ component: "approval-supersede" });

/**
 * THE MESSAGE THAT CHANGES A HELD REQUEST (supersede). An agent paused on a
 * gateway approval cannot read anything the person says until that request
 * is decided: steers only land between tool calls. So "make the city NYC"
 * sent while the card waits would sit unread until someone clicks Deny or
 * the card times out, and the agent would then see a bare "declined" with
 * no idea why.
 *
 * This closes the loop server-side. After a person's message is accepted,
 * the supersede judge (`judges/supersede-judge.ts`) decides whether it
 * changes what one of THIS agent's held requests is about to do. Only a
 * clear change denies it, with the reason `superseded`, so:
 *  - the agent gets a 403 that says "the user's newer message changes this
 *    request; read it and send a revised one", and then reads that message;
 *  - the card settles as "Replaced by your message" (Slack rewritten here,
 *    the web chat reads the transcript notice);
 *  - the deny is audited under the PERSON who sent the message.
 *
 * Fail-safe by construction: no key, a timeout, an error, or any verdict
 * but a change keeps the card. Nothing is ever approved. The worst case is
 * a card the person still wanted: the agent asks again.
 *
 * Fences:
 *  - only a person speaks for the request (`origin.userId` set, never an
 *    automation or a peer agent);
 *  - only THIS conversation's agent's approvals, read with the speaker's
 *    own workspace key, which the gateway re-fences to its workspace;
 *  - only while THIS conversation is the agent's one live exchange (an
 *    approval names its agent, not its conversation).
 */

/** Held requests one message may supersede (one task's approvals). */
const MAX_SUPERSEDED = 20;
/** The gateway read's budget (the judge keeps its own). */
const READ_DEADLINE_MS = 5_000;
/** How far back a still-pending log row can name a held request: longer
 * than any approval's lifetime (the gateway's hold is minutes). */
const HELD_LOOKBACK_MS = 60 * 60 * 1000;

/** The line the transcript (and so the web card and the model) reads. */
export const SUPERSEDED_NOTICE =
  "Replaced by your message: the waiting approval was withdrawn so your change can be applied.";
/** The settled Slack card's outcome, after the request's title. */
export const SUPERSEDED_CARD_TEXT = "Replaced by your message · not sent";

export interface SupersedeInput {
  workspaceId: string;
  conversationId: string;
  /** The live turn the person's message joined (the one that is waiting). */
  targetTurnId: string;
  message: string;
  origin: TurnOrigin;
}

/**
 * Run the check and, on REPLACE, deny the held request(s) as superseded.
 * Never throws: every failure keeps the card. Returns the denied ids.
 */
export const supersedeHeldApprovals = async (
  input: SupersedeInput,
): Promise<string[]> => {
  const userId = input.origin.userId;
  if (!userId) return [];
  // Every "keep" names why: the check is silent by design (fail-safe to
  // keeping the card), so a card that should have been replaced and wasn't
  // is otherwise undiagnosable. Ids and a reason only, never the message.
  const keep = (reason: string): string[] => {
    log.info(
      { conversationId: input.conversationId, reason },
      "supersede check kept the card",
    );
    return [];
  };
  // The reads and the model call get separate budgets: one shared clock let
  // a slow cold start (first DB connection, key mint) eat the judge's whole
  // budget, and the check then silently kept every card. The judge enforces
  // its own deadline (`defineJudge`); this one bounds the gateway read.
  const signal = AbortSignal.timeout(READ_DEADLINE_MS);
  try {
    const conversation = await db.conversation.findFirst({
      where: {
        id: input.conversationId,
        agent: { workspaceId: input.workspaceId },
      },
      select: {
        agent: {
          select: {
            id: true,
            name: true,
            workspaceId: true,
            workspace: { select: { organizationId: true } },
          },
        },
      },
    });
    if (!conversation) return keep("conversation outside the workspace");
    const { agent } = conversation;

    // Approvals carry no conversation id, only the agent. When the agent is
    // live in more than one conversation, the held request may belong to
    // another person's exchange: ambiguous, so keep.
    const liveConversations = await db.turn.findMany({
      where: {
        status: { in: [...ACTIVE_TURN_STATUSES] },
        conversation: { agentId: agent.id },
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
      take: 2,
    });
    if (
      liveConversations.length !== 1 ||
      liveConversations[0]?.conversationId !== input.conversationId
    ) {
      return keep("agent not live in exactly this conversation");
    }

    // Nothing held for this agent: the common case, answered from the
    // gateway's own request log (it writes an `approval_pending` row the
    // moment it holds a request) without minting a key or calling the
    // gateway. A stale pending row only costs the full check below.
    const anyHeld = await db.requestLog.findFirst({
      where: {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        extraData: { path: ["decision"], equals: "approval_pending" },
        createdAt: { gte: new Date(Date.now() - HELD_LOOKBACK_MS) },
      },
      select: { id: true },
    });
    if (!anyHeld) return keep("no held request");

    // The SPEAKER's own key: the gateway re-validates their live workspace
    // access per call and attributes the deny to them.
    const speaker = await db.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const userEmail = speaker?.email ?? "";
    const apiKey = await ensureWorkspaceApiKey({
      userId,
      userEmail,
      workspaceId: agent.workspaceId,
    });
    const held = (
      await listPendingApprovalsAtGateway({ serviceKey: apiKey, signal })
    ).filter((a) => a.agent?.id === agent.id);
    if (held.length === 0) return keep("no held request");

    const resolved = await resolveLlmCallKey(
      { id: agent.id, workspaceId: agent.workspaceId },
      agent.workspace.organizationId,
    );
    if (!resolved.ok) return keep(`no LLM key (${resolved.reason})`);

    const verdict = await judgeSupersede({
      key: resolved.key,
      agentName: agent.name,
      held,
      message: input.message,
    });
    if (verdict !== "replace") return keep("judged unrelated");

    const denied: GatewayPendingApproval[] = [];
    for (const approval of held.slice(0, MAX_SUPERSEDED)) {
      const result = await decideApprovalAtGateway({
        serviceKey: apiKey,
        approvalId: approval.id,
        decision: "deny",
        reason: "superseded",
      }).catch((err: unknown) => {
        log.warn(
          { err: String(err), approvalId: approval.id },
          "superseded deny failed; the card stays",
        );
        return null;
      });
      if (result?.outcome === "decided") denied.push(approval);
    }
    if (denied.length === 0) return keep("deny refused");

    await recordSupersede({
      ...input,
      userId,
      userEmail,
      agentId: agent.id,
      denied,
    });
    return denied.map((a) => a.id);
  } catch (err) {
    log.warn(
      { err: String(err), conversationId: input.conversationId },
      "supersede check failed; the card stays",
    );
    return [];
  }
};

/** Audit, transcript notice, and the channel card rewrite. Best-effort. */
const recordSupersede = async (input: {
  workspaceId: string;
  conversationId: string;
  targetTurnId: string;
  userId: string;
  userEmail: string;
  agentId: string;
  denied: GatewayPendingApproval[];
}): Promise<void> => {
  const ids = input.denied.map((a) => a.id);
  // Ledger first: the adapter's absence arm reads it on its next poll, and
  // a still-pending row there is relabeled "Decided from the dashboard".
  await rewriteGatewayApprovalCards({
    lines: new Map(ids.map((id) => [id, SUPERSEDED_CARD_TEXT])),
    describes: "card",
    titles: new Map(
      input.denied.flatMap((a) =>
        a.summary?.action ? [[a.id, a.summary.action] as const] : [],
      ),
    ),
    onlyPending: true,
  }).catch((err: unknown) =>
    log.warn({ err: String(err) }, "superseded card settle failed"),
  );

  await Promise.all(
    ids.map((approvalId) =>
      recordAuditEvent({
        workspaceId: input.workspaceId,
        userId: input.userId,
        userEmail: input.userEmail,
        action: AUDIT_ACTIONS.DENY,
        service: AUDIT_SERVICES.CONVERSATION,
        status: AUDIT_STATUS.SUCCESS,
        source: AUDIT_SOURCE.API,
        metadata: {
          approvalId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          reason: "superseded",
        },
      }).catch((err: unknown) =>
        log.warn({ err: String(err), approvalId }, "supersede audit failed"),
      ),
    ),
  );

  await writeConversationNotice({
    conversationId: input.conversationId,
    turnId: input.targetTurnId,
    level: "info",
    text: SUPERSEDED_NOTICE,
    extra: { supersededApprovalIds: ids },
  }).catch((err: unknown) =>
    log.warn({ err: String(err) }, "supersede notice failed"),
  );
};
