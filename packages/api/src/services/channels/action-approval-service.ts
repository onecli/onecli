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
import { cleanLabel } from "../../lib/format";
import { dashboardUrl } from "../../lib/dashboard-url";
import { logger } from "../../lib/logger";
import { writeConversationNotice } from "../conversation-notice";
import { previousRunStartedAt } from "../turn-service";
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
  /** The turn that asked (the notice anchor), when there was one. Lets a
   * handler attribute its follow-on records to the person who asked. */
  originTurnId: string | null;
  action: string;
  payload: Prisma.JsonValue;
  /** Who approved it. Lets a handler record follow-on grants in that
   * person's name (send_message: opening the recipient's replies). */
  decidedByUserId: string;
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
type ActionHandler = (
  approval: ApprovedAction,
  /** In-memory only, never persisted: the credential a
   * `requiresSecretValue` action's approver typed. Undefined otherwise. */
  context: { secretValue?: string },
) => Promise<string | void>;
// A handler may return a short platform-composed NOTE (never a secret) that
// rides the executed outcome line to the person and the model, e.g. the id
// of what it created.

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
  /** The approval can only execute with a credential the approver types
   * (custom connections). The generic decide doors (dashboard decision
   * route, Slack click) refuse to APPROVE it; only the action's dedicated
   * route, which carries the value, can. Rejecting stays generic. */
  requiresSecretValue?: boolean;
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
  options?: {
    alwaysAllow?: RegisteredAction["alwaysAllow"];
    requiresSecretValue?: boolean;
  },
): void => {
  if (handlers.has(action)) {
    throw new Error(`action handler already registered: ${action}`);
  }
  if (options?.requiresSecretValue && options.alwaysAllow) {
    // A standing grant would let a later approve skip the value.
    throw new Error(
      `a secret-value action can't offer always-allow: ${action}`,
    );
  }
  handlers.set(action, {
    handler,
    alwaysAllow: options?.alwaysAllow,
    requiresSecretValue: options?.requiresSecretValue === true,
  });
};

/** Whether approving this action needs a credential typed by the approver
 * (so only its dedicated route can approve it; see `RegisteredAction`). */
export const actionRequiresSecretValue = (action: string): boolean =>
  handlers.get(action)?.requiresSecretValue === true;

/** The refusal a generic door gives a value-requiring approve. */
export const NEEDS_SECRET_VALUE_MESSAGE =
  "This request needs a key that only you can enter. Review it in the OneCLI chat.";

/** Whether an action offers the "always allow" upgrade — the card renderer
 * and the bell's listing ask this to decide whether the third button exists
 * at all. */
export const actionSupportsAlwaysAllow = (action: string): boolean =>
  handlers.get(action)?.alwaysAllow !== undefined;

/** Test seam: pg proofs register throwaway actions per arm. */
export const unregisterActionHandler = (action: string): void => {
  handlers.delete(action);
};

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
      summary: cleanLabel(input.summary, MAX_SUMMARY_CHARS),
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
      // A value-requiring action is decided in the dashboard only: the
      // card is a link there, never an Approve button. Built inside the
      // guard: a misconfigured origin must fail the post, not the ask.
      const reviewUrl = actionRequiresSecretValue(approval.action)
        ? dashboardUrl(
            `/agents/${encodeURIComponent(approval.agent.id)}/chat`,
            { workspaceId: approval.agent.workspaceId },
          )
        : undefined;
      const ref = await cardUi.post({
        credentialsJson,
        recipientExternalUserId: owner.externalUserId,
        approvalId: approval.id,
        agentName: approval.agent.name,
        summary: approval.summary,
        offerAlwaysAllow: actionSupportsAlwaysAllow(approval.action),
        ...(reviewUrl && { reviewUrl }),
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
  | {
      kind: "decided";
      status: ActionApprovalStatus;
      /** What was decided, and by whom: the clicked card settles to the
       * same words every other posted card does. */
      summary: string;
      decidedByName: string;
    }
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
  /** The approver-typed credential for a `requiresSecretValue` action. Held
   * in memory for the handler call only: never written to the row, the
   * audit, the notice or a log. Only the action's dedicated route sets it. */
  secretValue?: string;
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
  // A value-requiring action can only be APPROVED with its value (the
  // dedicated route). Checked BEFORE the flip so the generic doors leave the
  // row pending for the real decision. Rejecting needs no value.
  if (
    input.decision !== "reject" &&
    actionRequiresSecretValue(approval.action) &&
    !input.secretValue
  ) {
    return { kind: "refused", message: NEEDS_SECRET_VALUE_MESSAGE };
  }
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
    input.reason !== undefined
      ? cleanLabel(input.reason, MAX_REASON_CHARS)
      : null;

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
  let detail: string | null = null;
  if (input.decision === "reject") {
    finalStatus = "rejected";
  } else {
    // Execute from the frozen row. Handler errors settle the approval
    // `failed` with the error recorded — they never 500 the click.
    const registered = handlers.get(approval.action);
    if (!registered) {
      finalStatus = "failed";
      detail = `no handler registered for "${approval.action}"`;
    } else {
      const frozen: ApprovedAction = {
        id: approval.id,
        agentId: approval.agentId,
        conversationId: approval.conversationId,
        originTurnId: approval.originTurnId,
        action: approval.action,
        payload: approval.payload,
        decidedByUserId: input.deciderUserId,
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
        const note = await registered.handler(frozen, {
          ...(registered.requiresSecretValue &&
            input.secretValue !== undefined && {
              secretValue: input.secretValue,
            }),
        });
        finalStatus = "executed";
        if (typeof note === "string" && note) {
          detail = cleanLabel(note, MAX_REASON_CHARS);
        }
      } catch (err) {
        finalStatus = "failed";
        detail = cleanLabel(String(err), MAX_REASON_CHARS);
      }
    }
    await db.actionApproval.update({
      where: { id: approval.id },
      data: { status: finalStatus, ...(detail ? { reason: detail } : {}) },
    });
  }

  await settleApproval(
    approval,
    finalStatus,
    decider.name || decider.email,
    input.decision === "reject" ? reason : detail,
  );
  return {
    kind: "decided",
    status: finalStatus,
    summary: approval.summary,
    decidedByName: decider.name || decider.email,
  };
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
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return { expired: await expireActionApprovals(stale.map((s) => s.id)) };
};

/**
 * Expire the named PENDING approvals now, settling cards and notices the
 * way the sweep does. Used by the sweep (past deadline) and by a subject's
 * removal (the ask is moot: the contact or link it was about is gone).
 * Atomic per row: a decide racing this wins or loses cleanly. Returns how
 * many actually flipped.
 */
export const expireActionApprovals = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) return 0;
  const rows = await db.actionApproval.findMany({
    where: { id: { in: ids }, status: "pending" },
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
  });
  let expired = 0;
  for (const approval of rows) {
    const flipped = await db.actionApproval.updateMany({
      where: { id: approval.id, status: "pending" },
      data: { status: "expired" },
    });
    if (flipped.count === 0) continue;
    expired += 1;
    await settleApproval(approval, "expired", null, null);
  }
  return expired;
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

/** The terminal statuses: every one has an outcome line. */
const SETTLED_STATUSES = [
  "executed",
  "failed",
  "rejected",
  "expired",
] as const satisfies readonly ActionApprovalStatus[];
type SettledStatus = (typeof SETTLED_STATUSES)[number];

const isSettledStatus = (status: string): status is SettledStatus =>
  (SETTLED_STATUSES as readonly string[]).includes(status);

const OUTCOME_LINES: Record<
  SettledStatus,
  (summary: string, detail: string | null) => string
> = {
  executed: (summary, note) =>
    note
      ? `Approved and done: ${summary}. ${note}`
      : `Approved and done: ${summary}.`,
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
 * The turn-start APPROVAL-OUTCOME note: every held action asked from THIS
 * conversation that was decided (or expired) since the model last ran here,
 * plus the asks still waiting. The `send_message`/`message_agent` tool
 * results promise the decision "arrives as a notice"; the durable notice
 * row is what the person sees in the transcript, and this note is the half
 * the MODEL reads. Without it the agent kept answering "still waiting for
 * approval" about a message that had already been delivered.
 *
 * The window is (the previous turn the model RAN started, now]. "Ran" is
 * the harness's own `turn.started` row: a report turn the platform wrote
 * (an automation delivery, a peer task's close) or a follow-up folded into
 * another run never reached the model, so it must not move the window.
 * `now` is dispatch time (this builder runs at dispatch), so a decision
 * landing while this turn sat in the queue is still news for it. No stored
 * "seen" flag: a decision is news for one run, and the next run's window
 * starts after it.
 *
 * Delivery-only context (the same law as the mention note): composed from
 * current truth at dispatch, never stored; the caller isolates failure.
 */
export const buildApprovalOutcomeNote = async (
  conversationId: string,
  turnCreatedAt: Date,
): Promise<string | null> => {
  // `startedAt` is written with the `turn.started` row (same transaction,
  // the app clock that also stamps `updatedAt` below).
  const since = await previousRunStartedAt(conversationId, turnCreatedAt);
  if (!since) return null;
  const now = new Date();

  const [settled, waiting] = await Promise.all([
    db.actionApproval.findMany({
      where: {
        conversationId,
        status: { in: [...SETTLED_STATUSES] },
        updatedAt: { gt: since, lte: now },
      },
      orderBy: { updatedAt: "desc" },
      take: APPROVAL_NOTE_MAX_ROWS,
      select: { status: true, summary: true, reason: true },
    }),
    // Only asks an owner can still decide: an expired row the sweep has
    // not parked yet is not "waiting" (it reads as expired once parked).
    db.actionApproval.findMany({
      where: { conversationId, status: "pending", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      take: APPROVAL_NOTE_MAX_ROWS,
      select: { summary: true },
    }),
  ]);

  // Newest rows win the cap; the note reads oldest first.
  const lines = [
    ...settled
      .reverse()
      .flatMap((a) =>
        isSettledStatus(a.status)
          ? [OUTCOME_LINES[a.status](a.summary, a.reason)]
          : [],
      ),
    ...waiting
      .reverse()
      .map((a) => `Still waiting for the owner's decision: ${a.summary}.`),
  ];
  if (lines.length === 0) return null;
  return [
    "Approval updates for actions you asked for in this conversation (current truth; trust these over your earlier replies):",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
};

/** Bounds the note: a conversation that asked for dozens of sends still
 * gets a context block, not a flood. */
const APPROVAL_NOTE_MAX_ROWS = 10;

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
  try {
    await writeConversationNotice({
      conversationId: approval.conversationId,
      turnId: approval.originTurnId,
      level: outcome === "executed" ? "info" : "warn",
      text: OUTCOME_LINES[outcome](approval.summary, detail),
      /** Structured for the next turn's context note. */
      extra: {
        actionApproval: { id: approval.id, action: approval.action, outcome },
      },
    });
  } catch (err) {
    log.warn(
      { approvalId: approval.id, err: String(err) },
      "action approval outcome notice failed",
    );
  }
};
