import { db } from "@onecli/db";
import type { Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  AUDIT_STATUS,
  recordAuditEvent,
} from "../audit-service";
import { getEventBus } from "../../providers/event-bus";
import { logger } from "../../lib/logger";
import { authorizeChannelUser } from "./channel-ingestion-service";
import { dmReachableOwners, cardRefsOf } from "./agent-reach-service";
import { channelProvider } from "./registry";
import type { ChannelProviderId } from "./types";

const log = logger.child({ service: "action-approval" });

/**
 * The ACTION-APPROVAL primitive — hold → card → decide → execute, for
 * one-shot privileged agent actions (send_message first; agent-to-agent
 * and spawning follow). The design record (2026-09-05, with the operator):
 *
 * - THE ROW IS THE SINGLE TRUTH. `payload` is written once at create and
 *   never updated; the card renders it and the approved handler executes
 *   exactly it. There is no wire-side copy to compare against, so there is
 *   no hash — the immutability pg proof is the contract's pin.
 * - One-shot only. Standing relationships stay in `agent_reach_grants`
 *   (their own lifecycle), gateway holds stay in
 *   `tool_approval_cards` (the gateway owns their deadlines). Shared
 *   plumbing (owner cards, claim-before-post, click authorization), never
 *   shared rows.
 * - `approved` is a DURABLE intermediate: the decide flips
 *   pending→approved atomically, THEN the handler runs, then
 *   executed/failed lands. A crash between leaves a visible, resumable
 *   row instead of a silent loss — and the atomic flip means a racing
 *   second decide reads already_settled, so a handler can never run twice.
 * - Outcomes are LOUD: every terminal state writes a durable notice on the
 *   origin turn (the mention-failure mechanism) — the person sees it in
 *   the transcript, the model reads it in its next turn's context. A
 *   rejection's reason rides along verbatim — the reject is a steer, not
 *   a dead end.
 */

export const ACTION_APPROVAL_STATUSES = [
  "pending",
  "approved", // transient: decide won, handler not yet finished
  "executed",
  "failed",
  "rejected",
  "expired",
] as const;
export type ActionApprovalStatus = (typeof ACTION_APPROVAL_STATUSES)[number];

/** A pending ask older than this decides itself: expired. Same posture as
 * the reach expiry — a stale card misleads; a fresh ask re-poses. */
const APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cap the summary a card renders and the reason a human types — both are
 * model-visible and card-visible text. */
const MAX_SUMMARY_CHARS = 600;
const MAX_REASON_CHARS = 500;

/** The executed row a handler receives: the frozen truth. */
export interface ApprovedAction {
  id: string;
  agentId: string;
  conversationId: string | null;
  action: string;
  payload: Prisma.JsonValue;
}

/**
 * The handler CONTRACT: bounded-fast (seconds, not minutes) — the Slack
 * click's decide awaits it inside the interactivity window, exactly like
 * the gateway decide and the reach card rewrites it sits beside. An action
 * whose work is long must do the quick, user-visible part here (post the
 * message, start the job) and let progress ride its own machinery; an
 * async-execution mode (ack first, execute after) is the recorded
 * follow-up if a future action genuinely needs it.
 */
type ActionHandler = (approval: ApprovedAction) => Promise<void>;

/**
 * One registered action: the execute handler, plus an optional standing-
 * grant hook. `alwaysAllow` runs on an `approve_always` decision AFTER the
 * atomic flip and BEFORE execution — it records the durable "stop asking"
 * decision (send_message: the contact upsert). Actions without the hook
 * treat `approve_always` as a plain approve — the card simply doesn't
 * offer the button for them.
 */
interface RegisteredAction {
  handler: ActionHandler;
  alwaysAllow?: (
    approval: ApprovedAction,
    deciderUserId: string,
  ) => Promise<void>;
}

/**
 * The handler registry — module-load registration, one handler per action
 * string (a duplicate is a wiring bug and throws immediately; a missing
 * handler at decide time fails the approval loudly instead of executing
 * nothing). Consumers: the pg proofs' test action today, send_message (4c)
 * next — the registry IS the 4c contract.
 */
const handlers = new Map<string, RegisteredAction>();

export const registerActionHandler = (
  action: string,
  handler: ActionHandler,
  options?: { alwaysAllow?: RegisteredAction["alwaysAllow"] },
): void => {
  if (handlers.has(action)) {
    throw new Error(`action handler already registered: ${action}`);
  }
  handlers.set(action, { handler, alwaysAllow: options?.alwaysAllow });
};

/** Whether an action offers the "always allow" upgrade — the card renderer
 * asks this to decide whether the third button exists at all. */
const actionSupportsAlwaysAllow = (action: string): boolean =>
  handlers.get(action)?.alwaysAllow !== undefined;

/** Test seam: pg proofs register throwaway actions per arm. */
export const unregisterActionHandler = (action: string): void => {
  handlers.delete(action);
};

const clamp = (raw: string, max: number): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * Create the hold and post the owner cards. The caller (a platform tool
 * case, a service) composes `summary` itself — it is the card's one-liner
 * and must be platform text around cleaned fields, never raw model output.
 * Card posting is failure-tolerant and per-post durable (the reach-card
 * idiom): a post that fails stays owed and the next sweep retries.
 */
export const requestActionApproval = async (input: {
  agentId: string;
  conversationId?: string | null;
  originTurnId?: string | null;
  action: string;
  payload: Prisma.InputJsonValue;
  summary: string;
  expiresInMs?: number;
}): Promise<{ id: string; status: "pending" }> => {
  if (!handlers.has(input.action)) {
    // Fail at REQUEST time, not decide time, when the wiring is knowably
    // broken — a card the owner approves into a failure is worse than an
    // error the requester hears immediately.
    throw new ServiceError(
      "UNPROCESSABLE",
      `No handler registered for action "${input.action}"`,
    );
  }
  const approval = await db.actionApproval.create({
    data: {
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      originTurnId: input.originTurnId ?? null,
      action: input.action,
      payload: input.payload,
      summary: clamp(input.summary, MAX_SUMMARY_CHARS),
      expiresAt: new Date(
        Date.now() + (input.expiresInMs ?? APPROVAL_MAX_AGE_MS),
      ),
      cardRefs: [],
    },
    select: { id: true },
  });
  await postActionApprovalCards(approval.id);
  return { id: approval.id, status: "pending" };
};

/**
 * Post the owner-DM cards for one pending approval — the `postReachCards`
 * structure exactly: DM-reachable workspace owners, claim-before-post via
 * cardRefs, per-post persistence, never throws into the request path.
 * Module-private: `requestActionApproval` is the only caller today; a
 * retry sweep for failed posts (the `sweepUnpostedReachCards` twin) joins
 * when 4c gives the primitive production traffic — exporting it now would
 * be an orphan surface.
 */
const postActionApprovalCards = async (approvalId: string): Promise<void> => {
  const approval = await db.actionApproval.findUnique({
    where: { id: approvalId },
    select: {
      id: true,
      status: true,
      action: true,
      summary: true,
      cardRefs: true,
      agent: { select: { id: true, name: true, workspaceId: true } },
    },
  });
  if (!approval || approval.status !== "pending") return;

  // The card rides the agent's ACTIVE channel presence — same delivery
  // door as reach cards. No presence = dashboard-only pending, which is
  // the durable surface anyway.
  const presence = await db.agentChannel.findFirst({
    where: { agentId: approval.agent.id, status: "active" },
    select: {
      id: true,
      provider: true,
      integrationId: true,
      credentials: true,
    },
  });
  if (!presence?.credentials) return;
  const reach = channelProvider(presence.provider as ChannelProviderId).reach;
  const cardUi = channelProvider(
    presence.provider as ChannelProviderId,
  ).actionApprovalCard;
  if (!reach || !cardUi) return;

  const posted = cardRefsOf(approval.cardRefs);
  const alreadyNotified = new Set(posted.map((p) => p.userId));
  const owners = await dmReachableOwners(
    approval.agent.workspaceId,
    presence.integrationId,
  );
  const owed = owners.filter((o) => !alreadyNotified.has(o.userId));
  if (owed.length === 0) return;

  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  for (const owner of owed) {
    try {
      const ref = await cardUi.post({
        credentialsJson,
        recipientExternalUserId: owner.externalUserId,
        approvalId: approval.id,
        agentName: approval.agent.name,
        summary: approval.summary,
        offerAlwaysAllow: actionSupportsAlwaysAllow(approval.action),
      });
      posted.push({ channel: ref.channel, ts: ref.ts, userId: owner.userId });
      await db.actionApproval.update({
        where: { id: approval.id },
        data: { cardRefs: posted.map((p) => ({ ...p })) },
      });
    } catch (err) {
      log.warn(
        { approvalId: approval.id, err: String(err) },
        "action approval card post failed; the sweep retries",
      );
    }
  }
};

export type ActionDecisionResult =
  | { kind: "decided"; status: ActionApprovalStatus }
  | { kind: "already_settled" }
  | { kind: "refused"; message: string };

/**
 * The one decide door. Both transports land here: the Slack card click
 * (via `decideActionApprovalFromChannel`, clicker pre-authorized) and the
 * dashboard route (caller's workspace access is the authority).
 */
export const decideActionApproval = async (input: {
  approvalId: string;
  /** `approve_always` = approve AND record the standing grant (the
   * registered action's `alwaysAllow` hook) — an action without the hook
   * treats it as a plain approve. */
  decision: "approve" | "approve_always" | "reject";
  deciderUserId: string;
  reason?: string;
}): Promise<ActionDecisionResult> => {
  const approval = await db.actionApproval.findUnique({
    where: { id: input.approvalId },
    select: {
      id: true,
      status: true,
      action: true,
      payload: true,
      summary: true,
      agentId: true,
      conversationId: true,
      originTurnId: true,
      cardRefs: true,
      expiresAt: true,
      agent: { select: { workspaceId: true, name: true } },
    },
  });
  if (!approval) {
    return { kind: "refused", message: "This request no longer exists." };
  }
  if (approval.status !== "pending") return { kind: "already_settled" };
  if (approval.expiresAt.getTime() < Date.now()) {
    // Lazily park an expired-but-unswept row so a click never approves a
    // dead ask. The same atomic flip as the sweep — a racing sweep or twin
    // decide loses cleanly — then cards + notice settle.
    const parked = await db.actionApproval.updateMany({
      where: { id: approval.id, status: "pending" },
      data: { status: "expired" },
    });
    if (parked.count > 0) await settleApproval(approval, "expired", null, null);
    return {
      kind: "refused",
      message: "This request expired. The agent can ask again.",
    };
  }

  const decider = await db.user.findUnique({
    where: { id: input.deciderUserId },
    select: { name: true, email: true },
  });
  if (!decider) return { kind: "refused", message: "Unknown decider." };

  const reason =
    input.reason !== undefined ? clamp(input.reason, MAX_REASON_CHARS) : null;

  const approves = input.decision !== "reject";
  // THE ATOMIC FLIP (the 4a race lesson, applied from day one): conditioned
  // on `pending`, so a racing decide, sweep, or twin reads already_settled
  // and the handler can never run twice.
  const flipped = await db.actionApproval.updateMany({
    where: { id: approval.id, status: "pending" },
    data: {
      status: approves ? "approved" : "rejected",
      decidedByUserId: input.deciderUserId,
      decidedAt: new Date(),
      ...(input.decision === "reject" && reason ? { reason } : {}),
    },
  });
  if (flipped.count === 0) return { kind: "already_settled" };

  await recordAuditEvent({
    workspaceId: approval.agent.workspaceId,
    userId: input.deciderUserId,
    userEmail: decider.email,
    action: approves ? AUDIT_ACTIONS.APPROVE : AUDIT_ACTIONS.DENY,
    service: AUDIT_SERVICES.CHANNEL,
    status: AUDIT_STATUS.SUCCESS,
    source: AUDIT_SOURCE.API,
    // Ids and the action name — never the payload (may hold message text).
    metadata: {
      actionApprovalId: approval.id,
      agentId: approval.agentId,
      action: approval.action,
      decision: input.decision,
    },
  });

  let finalStatus: ActionApprovalStatus;
  let failure: string | null = null;
  if (input.decision === "reject") {
    finalStatus = "rejected";
  } else {
    // Execute from the frozen row. Handler errors settle the approval
    // `failed` with the error recorded — they never 500 the click.
    const registered = handlers.get(approval.action);
    if (!registered) {
      finalStatus = "failed";
      failure = `no handler registered for "${approval.action}"`;
    } else {
      const frozen: ApprovedAction = {
        id: approval.id,
        agentId: approval.agentId,
        conversationId: approval.conversationId,
        action: approval.action,
        payload: approval.payload,
      };
      // The standing grant FIRST, best-effort: a failed upsert must not
      // block the send the owner just approved — the next send simply asks
      // again, which is the safe direction to fail in.
      if (input.decision === "approve_always" && registered.alwaysAllow) {
        try {
          await registered.alwaysAllow(frozen, input.deciderUserId);
        } catch (err) {
          log.warn(
            { approvalId: approval.id, err: String(err) },
            "always-allow grant failed; the send still executes",
          );
        }
      }
      try {
        await registered.handler(frozen);
        finalStatus = "executed";
      } catch (err) {
        finalStatus = "failed";
        failure = clamp(String(err), MAX_REASON_CHARS);
      }
    }
    await db.actionApproval.update({
      where: { id: approval.id },
      data: { status: finalStatus, ...(failure ? { reason: failure } : {}) },
    });
  }

  await settleApproval(
    approval,
    finalStatus,
    decider.name || decider.email,
    input.decision === "reject" ? reason : failure,
  );
  return { kind: "decided", status: finalStatus };
};

/**
 * The Slack card click's decide door — mirrors `decideReachFromChannel`:
 * the clicker is authorized as a workspace-access holder BEFORE anything
 * flips (a card in someone's DM is not authority), and the approval must
 * belong to THIS presence's agent — a forged id from another tenant gets
 * a not-found-shaped refusal, hint-free.
 */
export const decideActionApprovalFromChannel = async (input: {
  presenceId: string;
  approvalId: string;
  decision: "approve" | "approve_always" | "reject";
  clickerExternalUserId: string;
}): Promise<ActionDecisionResult> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: input.presenceId },
    select: {
      integrationId: true,
      provider: true,
      credentials: true,
      agent: {
        select: {
          id: true,
          workspace: { select: { id: true, organizationId: true } },
        },
      },
    },
  });
  if (!presence) {
    return { kind: "refused", message: "This agent is no longer attached." };
  }

  const approval = await db.actionApproval.findUnique({
    where: { id: input.approvalId },
    select: { agentId: true },
  });
  if (!approval || approval.agentId !== presence.agent.id) {
    return { kind: "refused", message: "This request no longer exists." };
  }

  let email: string | undefined;
  const existingLink = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId: input.clickerExternalUserId,
      },
    },
    select: { id: true },
  });
  if (!existingLink) {
    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    email = await channelProvider(
      presence.provider as ChannelProviderId,
    ).lookupUserEmail({
      credentialsJson,
      externalUserId: input.clickerExternalUserId,
    });
  }
  const clicker = await authorizeChannelUser(
    presence.integrationId,
    presence.agent.workspace.organizationId,
    presence.agent.workspace,
    input.clickerExternalUserId,
    email,
  );
  if (!clicker) {
    return {
      kind: "refused",
      message:
        "Only workspace members can decide this. Ask an admin for access, or decide it from the dashboard.",
    };
  }

  return decideActionApproval({
    approvalId: input.approvalId,
    decision: input.decision,
    deciderUserId: clicker.userId,
  });
};

/**
 * Park pending approvals past their deadline — rides the adapter's slow
 * loop beside the reach expiry (same endpoint pattern). Idempotent,
 * bounded, and LOUD: each expiry writes the outcome notice so the agent
 * learns the ask died instead of waiting forever.
 */
export const expireStaleActionApprovals = async (): Promise<{
  expired: number;
}> => {
  const stale = await db.actionApproval.findMany({
    where: { status: "pending", expiresAt: { lt: new Date() } },
    select: {
      id: true,
      status: true,
      action: true,
      summary: true,
      agentId: true,
      conversationId: true,
      originTurnId: true,
      cardRefs: true,
      agent: { select: { workspaceId: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let expired = 0;
  for (const approval of stale) {
    // Atomic per row: a decide racing the sweep wins or loses cleanly.
    const flipped = await db.actionApproval.updateMany({
      where: { id: approval.id, status: "pending" },
      data: { status: "expired" },
    });
    if (flipped.count === 0) continue;
    expired += 1;
    await settleApproval(approval, "expired", null, null);
  }
  return { expired };
};

/** The dashboard list — workspace-fenced by the caller's route. */
export const listActionApprovals = async (input: {
  workspaceId: string;
  agentId: string;
  status?: ActionApprovalStatus;
}) => {
  const rows = await db.actionApproval.findMany({
    // Fenced at the QUERY: the agent must belong to the caller's workspace.
    where: {
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
      ...(input.status ? { status: input.status } : {}),
    },
    select: {
      id: true,
      action: true,
      summary: true,
      status: true,
      reason: true,
      decidedAt: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows;
};

// ── Settlement: cards + the outcome notice ─────────────────────────────────

const OUTCOME_LINES: Record<
  Exclude<ActionApprovalStatus, "pending" | "approved">,
  (summary: string, detail: string | null) => string
> = {
  executed: (summary) => `Approved and done: ${summary}.`,
  rejected: (summary, reason) =>
    reason
      ? `Rejected: ${summary}. The reason given: "${reason}" - adjust and ask again if it still matters.`
      : `Rejected: ${summary}. No reason was given.`,
  failed: (summary, error) =>
    `Approved but FAILED: ${summary}. Error: ${error ?? "unknown"}. Tell the person - never claim it happened.`,
  expired: (summary) =>
    `Expired unanswered: ${summary}. Nobody decided in time - ask again if it still matters.`,
};

/**
 * Settle every posted card and write the durable outcome notice on the
 * origin turn (the mention-notice mechanism: visible in the web
 * transcript, read by the model's next-turn context). Best-effort on both
 * halves — the status row is already durable truth.
 */
const settleApproval = async (
  approval: {
    id: string;
    action: string;
    summary: string;
    agentId: string;
    conversationId: string | null;
    originTurnId: string | null;
    cardRefs: unknown;
    agent: { name: string };
  },
  outcome: Exclude<ActionApprovalStatus, "pending" | "approved">,
  decidedByName: string | null,
  detail: string | null,
): Promise<void> => {
  // Cards first — the presence lookup mirrors the post path.
  const refs = cardRefsOf(approval.cardRefs);
  if (refs.length > 0) {
    const presence = await db.agentChannel.findFirst({
      where: { agentId: approval.agentId, status: "active" },
      select: { provider: true, credentials: true },
    });
    const cardUi = presence
      ? channelProvider(presence.provider as ChannelProviderId)
          .actionApprovalCard
      : null;
    if (presence?.credentials && cardUi) {
      const credentialsJson = await getCrypto().decrypt(presence.credentials);
      for (const ref of refs) {
        try {
          await cardUi.settle({
            credentialsJson,
            channel: ref.channel,
            ts: ref.ts,
            summary: approval.summary,
            outcome,
            decidedByName: decidedByName ?? "",
          });
        } catch (err) {
          log.warn(
            { approvalId: approval.id, err: String(err) },
            "action approval card settle failed",
          );
        }
      }
    }
  }

  // The notice — needs a turn anchor; without one the row is still the
  // durable record and the dashboard shows it.
  if (!approval.conversationId || !approval.originTurnId) return;
  const text = OUTCOME_LINES[outcome](approval.summary, detail);
  try {
    const published = await db.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: approval.conversationId! },
        select: { id: true },
      });
      if (!conversation) return null;
      const { lastSeq } = await tx.conversation.update({
        where: { id: approval.conversationId! },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      const event = {
        type: "notice" as const,
        level: outcome === "executed" ? ("info" as const) : ("warn" as const),
        text,
        /** Structured for the next turn's context note. */
        actionApproval: { id: approval.id, action: approval.action, outcome },
      };
      await tx.turnEvent.create({
        data: {
          conversationId: approval.conversationId!,
          turnId: approval.originTurnId!,
          seq: lastSeq,
          type: "notice",
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
      return [
        {
          seq: lastSeq,
          turnId: approval.originTurnId!,
          type: "notice" as const,
          event,
        },
      ];
    });
    if (published) getEventBus().publish(approval.conversationId, published);
  } catch (err) {
    log.warn(
      { approvalId: approval.id, err: String(err) },
      "action approval outcome notice failed",
    );
  }
};
