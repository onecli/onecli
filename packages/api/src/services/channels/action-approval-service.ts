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
import { APPROVAL_RESUME_SOURCE } from "../../validations/conversation";
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

/** A decision on one action approval. */
export type ActionDecision = "approve" | "reject";

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
  context: {
    secretValue?: string;
    /** The option the decider picked, for an action that offers
     * `choices` (e.g. choose-sender: "agent" | "you"). */
    choice?: string;
  },
) => Promise<string | HandlerResult | void>;

/** A handler's richer answer. `chained` = the approved step did not finish
 * the job: it raised ANOTHER card (e.g. a sender pick that hit a blocked
 * contact). The row still settles executed, but the outcome line is the
 * note alone (never "Approved and done") and the agent is NOT resumed: the
 * final card's outcome resumes it. `resume` = the true outcome line the
 * resume turn opens with (default: "The person approved: <summary>"). */
export interface HandlerResult {
  note: string;
  chained?: boolean;
  resume?: string;
}
// A handler may return a short platform-composed NOTE (never a secret) that
// rides the executed outcome line to the person and the model, e.g. the id
// of what it created.

/**
 * One registered action: the execute handler, plus the optional STANDING
 * question. An action with `standing` never asks about one occurrence: it
 * asks about who the approval concerns, and its only answers are Always
 * allow and Never. `standing.allow` runs after an approve, AFTER the handler
 * (the send must still see the recipient as new: the first-contact
 * introduction depends on it), and holds even if this one delivery failed.
 * `standing.never` runs after a reject. Both are best-effort: a failed
 * write only means the next occurrence asks again.
 */
interface RegisteredAction {
  handler: ActionHandler;
  standing?: {
    allow: (approval: ApprovedAction, deciderUserId: string) => Promise<void>;
    never: (approval: ApprovedAction, deciderUserId: string) => Promise<void>;
  };
  /** The approval can only execute with a credential the approver types
   * (custom connections). The generic decide doors (dashboard decision
   * route, Slack click) refuse to APPROVE it; only the action's dedicated
   * route, which carries the value, can. Rejecting stays generic. */
  requiresSecretValue?: boolean;
  /** The ONE person who decides (their own data or voice is at stake, e.g.
   * "act as you in Slack"): read from the frozen payload. Their card goes
   * to THEM (not the workspace owners) and every decide door refuses
   * anyone else. Null from the resolver = a malformed payload: owners get
   * the card, and the decide is refused for everyone (fail closed). */
  decidedBy?: (
    payload: Prisma.JsonValue,
  ) => { userId: string; externalUserId: string } | null;
  /** Cap on the handler's returned note (default MAX_REASON_CHARS). A read
   * whose RESULT is the note (an approved "read as you") needs room. */
  noteMaxChars?: number;
  /** False (from the frozen payload) = no Slack DM card: the dashboard card
   * is the only surface (e.g. "connect your Slack", which the person can't
   * act on from Slack yet). Default: post. */
  dmCard?: (payload: Prisma.JsonValue) => boolean;
  /** False = this approval can't be APPROVED by any decide door (it
   * resolves through another flow, e.g. completing Slack connect); the
   * refusal message is returned instead. Rejecting stays allowed. */
  approvable?: (payload: Prisma.JsonValue) => true | string;
  /** Wake the origin conversation once this executes, so the agent picks
   * the original request back up without the person typing. Only ever a
   * DIRECT thread (a verified reader's own chat), never a shared one. */
  resumeOnExecute?: boolean;
  /** The action is answered by picking ONE of these options (not
   * approve/reject): an approve must carry one of them, reject = Cancel.
   * Labels are platform text, rendered as the card's buttons. */
  choices?: (payload: Prisma.JsonValue) => { value: string; label: string }[];
  /** The handler's note IS the whole executed outcome line (it says what
   * happened in plain words, e.g. "Sent as Helper to Sam" or "One more
   * step"), never prefixed with "Approved and done". */
  noteIsOutcome?: boolean;
  /** Who and what this ask is about, as a stable key (from the frozen
   * payload): the decider, the family and the recipient / conversation /
   * message. When an ask is created or decided, OLDER still-pending asks of
   * the same action with the same key are superseded (quietly expired:
   * "Replaced by a newer request."), so a stale card never lingers beside
   * the fresh one. Null = never superseded. */
  supersedeKey?: (payload: Prisma.JsonValue) => string | null;
  /** The Slack DM card is a link into OneCLI instead of decide buttons
   * (e.g. "Connect your Slack", which only the web flow can do). Null from
   * the resolver = the normal card. */
  dmLink?: (
    payload: Prisma.JsonValue,
    ctx: { agentId: string; workspaceId: string },
  ) => { url: string; label: string; note: string } | null;
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
  options?: Omit<RegisteredAction, "handler">,
): void => {
  if (handlers.has(action)) {
    throw new Error(`action handler already registered: ${action}`);
  }
  if (options?.requiresSecretValue && options.standing) {
    // A standing allow would let a later occurrence skip the value.
    throw new Error(
      `a secret-value action can't ask a standing question: ${action}`,
    );
  }
  handlers.set(action, {
    handler,
    standing: options?.standing,
    requiresSecretValue: options?.requiresSecretValue === true,
    ...(options?.decidedBy && { decidedBy: options.decidedBy }),
    ...(options?.noteMaxChars && { noteMaxChars: options.noteMaxChars }),
    ...(options?.dmCard && { dmCard: options.dmCard }),
    ...(options?.approvable && { approvable: options.approvable }),
    ...(options?.resumeOnExecute && { resumeOnExecute: true }),
    ...(options?.choices && { choices: options.choices }),
    ...(options?.noteIsOutcome && { noteIsOutcome: true }),
    ...(options?.supersedeKey && { supersedeKey: options.supersedeKey }),
    ...(options?.dmLink && { dmLink: options.dmLink }),
  });
};

/** What runs when an approval ends WITHOUT executing (rejected /
 * expired): may undo a side effect an EARLIER step set up for it (e.g. the
 * sender a chained pick stored) and return the true outcome line to resume
 * the agent with (only for a `resumeOnExecute` action); null = no resume.
 * A list per action, so the module that chained into a card can listen
 * without the card's own module knowing it. Best-effort. */
type AbandonListener = (
  approval: { id: string; agentId: string; payload: Prisma.JsonValue },
  outcome: "rejected" | "expired" | "failed",
) => Promise<string | null>;
const abandonListeners = new Map<string, AbandonListener[]>();

export const onActionAbandoned = (
  action: string,
  listener: AbandonListener,
): void => {
  abandonListeners.set(action, [
    ...(abandonListeners.get(action) ?? []),
    listener,
  ]);
};

/** The one person who decides this approval, when the action is personal
 * (see `RegisteredAction.decidedBy`); undefined = the workspace's
 * ordinary deciders. */
const personalDeciderOf = (
  action: string,
  payload: Prisma.JsonValue,
): { userId: string } | null | undefined => {
  const resolve = handlers.get(action)?.decidedBy;
  return resolve ? resolve(payload) : undefined;
};

/** Whether `viewerUserId` may see this approval at all: an ordinary one is
 * the workspace's; a personal one only its decider's (a malformed personal
 * payload resolves to nobody, so it shows to no one: fail closed). */
export const isVisibleTo = (
  action: string,
  payload: Prisma.JsonValue,
  viewerUserId: string | undefined,
): boolean => {
  const personal = personalDeciderOf(action, payload);
  return personal === undefined || personal?.userId === viewerUserId;
};

/** Whether this action asks a standing question (Always allow / Never)
 * rather than about one occurrence. The card and the bell render those two
 * words. */
export const isStandingChoice = (action: string): boolean =>
  handlers.get(action)?.standing !== undefined;

/** Whether approving this action needs a credential typed by the approver
 * (so only its dedicated route can approve it; see `RegisteredAction`). */
export const actionRequiresSecretValue = (action: string): boolean =>
  handlers.get(action)?.requiresSecretValue === true;

/** The refusal a generic door gives a value-requiring approve. */
export const NEEDS_SECRET_VALUE_MESSAGE =
  "This request needs a key that only you can enter. Review it in the OneCLI chat.";

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
    select: { id: true, createdAt: true },
  });
  await supersedeOlderSameKey({
    id: approval.id,
    agentId: input.agentId,
    action: input.action,
    payload: input.payload as Prisma.JsonValue,
    createdAt: approval.createdAt,
  });
  await postActionApprovalCards(approval.id);
  return { id: approval.id, status: "pending" };
};

/**
 * Supersede the OLDER still-pending asks of the same action and key (see
 * `RegisteredAction.supersedeKey`). Best-effort: a leftover stale card is
 * noise, never a wrong action, so a failure never breaks the caller.
 */
const supersedeOlderSameKey = async (row: {
  id: string;
  agentId: string;
  action: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
}): Promise<void> => {
  const keyOf = handlers.get(row.action)?.supersedeKey;
  if (!keyOf) return;
  try {
    const key = keyOf(row.payload);
    if (key === null) return;
    const older = await db.actionApproval.findMany({
      where: {
        agentId: row.agentId,
        action: row.action,
        status: "pending",
        id: { not: row.id },
        createdAt: { lte: row.createdAt },
      },
      select: { id: true, payload: true },
    });
    await supersedeActionApprovals(
      older.filter((o) => keyOf(o.payload) === key).map((o) => o.id),
    );
  } catch (err) {
    log.warn(
      { approvalId: row.id, err: String(err) },
      "superseding older asks failed",
    );
  }
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
      payload: true,
      agent: { select: { id: true, name: true, workspaceId: true } },
    },
  });
  if (!approval || approval.status !== "pending") return;
  const dmCard = handlers.get(approval.action)?.dmCard;
  if (dmCard && !dmCard(approval.payload)) return;

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
  // A personal action's card goes to the one person who decides it (their
  // Slack id is captured in the payload), never to the owners.
  const resolveDecider = handlers.get(approval.action)?.decidedBy;
  const decider = resolveDecider ? resolveDecider(approval.payload) : null;
  // The payload may predate the person's Slack link (e.g. asked before they
  // connected): their DM is found from the link when it exists now.
  const personal =
    decider && !decider.externalUserId
      ? await db.channelUserLink
          .findFirst({
            where: {
              integrationId: presence.integrationId,
              userId: decider.userId,
            },
            select: { externalUserId: true },
          })
          .then((l) =>
            l
              ? { userId: decider.userId, externalUserId: l.externalUserId }
              : null,
          )
      : decider;
  if (resolveDecider && !personal) return;
  const owners = personal
    ? [personal]
    : await dmReachableOwners(
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
      const link =
        handlers.get(approval.action)?.dmLink?.(approval.payload, {
          agentId: approval.agent.id,
          workspaceId: approval.agent.workspaceId,
        }) ?? null;
      const ref = await cardUi.post({
        credentialsJson,
        recipientExternalUserId: owner.externalUserId,
        approvalId: approval.id,
        agentName: approval.agent.name,
        summary: approval.summary,
        standingChoice: isStandingChoice(approval.action),
        ...(reviewUrl && { reviewUrl }),
        ...(link && { link }),
        ...(handlers.get(approval.action)?.choices && {
          choices: handlers.get(approval.action)!.choices!(approval.payload),
        }),
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
      /** A standing question: the card says Always allowed / Never. */
      standing: boolean;
      /** The handler's own outcome line for an executed action, for the
       * deciding surface to say (e.g. "Sent to Sam."). Absent when the
       * note is data rather than words (a read's result). */
      note?: string;
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
  /** On a standing question (`RegisteredAction.standing`) an approve is
   * Always allow and a reject is Never. */
  decision: ActionDecision;
  deciderUserId: string;
  reason?: string;
  /** The picked option, for an action that offers `choices`: required to
   * approve it; ignored elsewhere. */
  choice?: string;
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
      createdAt: true,
      agent: { select: { workspaceId: true, name: true } },
    },
  });
  if (!approval) {
    return { kind: "refused", message: "This request no longer exists." };
  }
  if (approval.status !== "pending") return { kind: "already_settled" };
  // A personal action is decided by its one person only (checked before
  // anything flips, so a refused click leaves it pending for them).
  const decidedBy = handlers.get(approval.action)?.decidedBy;
  if (decidedBy) {
    const decider = decidedBy(approval.payload);
    if (!decider || decider.userId !== input.deciderUserId) {
      return {
        kind: "refused",
        message:
          "Only the person whose Slack account the agent would use can decide this.",
      };
    }
  }
  // An action that resolves through another flow can't be approved here.
  if (input.decision !== "reject") {
    const approvable = handlers
      .get(approval.action)
      ?.approvable?.(approval.payload);
    if (typeof approvable === "string") {
      return { kind: "refused", message: approvable };
    }
  }
  // A choice action is approved only by picking one of its options.
  const choices = handlers.get(approval.action)?.choices;
  if (input.decision !== "reject" && choices) {
    const offered = choices(approval.payload).map((c) => c.value);
    if (!input.choice || !offered.includes(input.choice)) {
      return { kind: "refused", message: "Pick one of the options." };
    }
  }
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
  let chained = false;
  let resume: string | null = null;
  const registered = handlers.get(approval.action);
  const frozen: ApprovedAction = {
    id: approval.id,
    agentId: approval.agentId,
    conversationId: approval.conversationId,
    originTurnId: approval.originTurnId,
    action: approval.action,
    payload: approval.payload,
    decidedByUserId: input.deciderUserId,
  };
  // The standing answer, best-effort: a failed write never changes this
  // decision's outcome; the next occurrence simply asks again.
  const recordStanding = async (answer: "allow" | "never") => {
    if (!registered?.standing) return;
    try {
      await registered.standing[answer](frozen, input.deciderUserId);
    } catch (err) {
      log.warn(
        { approvalId: approval.id, answer, err: String(err) },
        "the standing answer was not recorded",
      );
    }
  };
  if (input.decision === "reject") {
    finalStatus = "rejected";
    await recordStanding("never");
  } else {
    // Execute from the frozen row. Handler errors settle the approval
    // `failed` with the error recorded — they never 500 the click.
    if (!registered) {
      finalStatus = "failed";
      detail = `no handler registered for "${approval.action}"`;
    } else {
      try {
        const note = await registered.handler(frozen, {
          ...(registered.choices &&
            input.choice !== undefined && { choice: input.choice }),
          ...(registered.requiresSecretValue &&
            input.secretValue !== undefined && {
              secretValue: input.secretValue,
            }),
        });
        finalStatus = "executed";
        const text = typeof note === "string" ? note : (note?.note ?? "");
        if (note && typeof note === "object") {
          chained = note.chained === true;
          resume = note.resume ?? null;
        }
        if (text) {
          detail = cleanLabel(
            text,
            registered.noteMaxChars ?? MAX_REASON_CHARS,
          );
        }
      } catch (err) {
        finalStatus = "failed";
        detail = cleanLabel(String(err), MAX_REASON_CHARS);
      }
      // AFTER the handler (see `RegisteredAction.standing`): the owner
      // answered about who, not about this one occurrence.
      await recordStanding("allow");
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
    { chained, resume },
  );
  // A decided ask answers the older ones about the same thing.
  await supersedeOlderSameKey(approval);
  return {
    kind: "decided",
    status: finalStatus,
    summary: approval.summary,
    decidedByName: decider.name || decider.email,
    standing: registered?.standing !== undefined,
    ...(finalStatus === "executed" &&
      detail &&
      registered?.noteMaxChars === undefined && { note: detail }),
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
  decision: ActionDecision;
  clickerExternalUserId: string;
  /** A choice card's picked option (see `RegisteredAction.choices`). */
  choice?: string;
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
    ...(input.choice !== undefined && { choice: input.choice }),
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
      payload: true,
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

/**
 * Settle the named PENDING approvals as executed by another flow (e.g. the
 * person completed Slack connect), with a note on the outcome. Atomic per
 * row, like expiry. Returns how many flipped.
 */
export const resolveActionApprovals = async (
  ids: string[],
  note: string,
  /** chained = the other flow raised another card (no resume); resume =
   * the true outcome line to wake the agent with. */
  how: { chained?: boolean; resume?: string } = {},
): Promise<number> => {
  if (ids.length === 0) return 0;
  const rows = await db.actionApproval.findMany({
    where: { id: { in: ids }, status: "pending" },
    select: {
      id: true,
      action: true,
      summary: true,
      agentId: true,
      conversationId: true,
      originTurnId: true,
      cardRefs: true,
      payload: true,
      agent: { select: { name: true } },
    },
  });
  const detail = cleanLabel(note, MAX_REASON_CHARS);
  let done = 0;
  for (const approval of rows) {
    const flipped = await db.actionApproval.updateMany({
      where: { id: approval.id, status: "pending" },
      data: { status: "executed", decidedAt: new Date(), reason: detail },
    });
    if (flipped.count === 0) continue;
    done += 1;
    await settleApproval(approval, "executed", null, detail, how);
  }
  return done;
};

/**
 * Withdraw the named PENDING approvals because a newer request replaced
 * them (e.g. a stale "connect your Slack" card under a fresher send). They
 * park as expired with a plain reason; cards settle, but no notice and no
 * resume: the newer card is what the person acts on. Returns how many.
 */
export const supersedeActionApprovals = async (
  ids: string[],
): Promise<number> => {
  if (ids.length === 0) return 0;
  const rows = await db.actionApproval.findMany({
    where: { id: { in: ids }, status: "pending" },
    select: {
      id: true,
      action: true,
      summary: true,
      agentId: true,
      conversationId: true,
      originTurnId: true,
      cardRefs: true,
      payload: true,
      agent: { select: { name: true } },
    },
  });
  let done = 0;
  for (const approval of rows) {
    const flipped = await db.actionApproval.updateMany({
      where: { id: approval.id, status: "pending" },
      data: { status: "expired", reason: "Replaced by a newer request." },
    });
    if (flipped.count === 0) continue;
    done += 1;
    await settleApproval(approval, "expired", null, null, { quiet: true });
  }
  return done;
};

/** The dashboard list — workspace-fenced by the caller's route. A
 * PERSONAL action (its `decidedBy`: "act as you in Slack") carries that
 * person's own data in its summary and outcome (an approved read's result
 * IS the outcome), so it is listed only to them: the bell's rule. */
export const listActionApprovals = async (input: {
  workspaceId: string;
  agentId: string;
  viewerUserId: string;
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
      payload: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.flatMap(({ payload, ...row }) =>
    isVisibleTo(row.action, payload, input.viewerUserId) ? [row] : [],
  );
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

/** One settled ask in words, for the person (the notice) and the model (the
 * next turn's note). A standing question says its own answer: Always allow
 * or Never was about who, so a Never is final, never "ask again". */
const OUTCOME_LINES: Record<
  SettledStatus,
  (summary: string, detail: string | null, standing: boolean) => string
> = {
  executed: (summary, note, standing) => {
    const head = standing ? "Always allowed and done" : "Approved and done";
    return note ? `${head}: ${summary}. ${note}` : `${head}: ${summary}.`;
  },
  rejected: (summary, reason, standing) => {
    if (standing) {
      const given = reason ? ` The reason given: "${reason}".` : "";
      return `Never: ${summary}.${given} Don't ask again.`;
    }
    return reason
      ? `Rejected: ${summary}. The reason given: "${reason}" - adjust and ask again if it still matters.`
      : `Rejected: ${summary}. No reason was given.`;
  },
  failed: (summary, error, standing) =>
    `${standing ? "Always allowed" : "Approved"} but FAILED: ${summary}. Error: ${error ?? "unknown"}. Tell the person - never claim it happened.`,
  expired: (summary) =>
    `Expired unanswered: ${summary}. Nobody decided in time - ask again if it still matters.`,
};

/** One settled row's outcome line (the notice and the turn-start note). */
const outcomeLine = (
  action: string,
  status: SettledStatus,
  summary: string,
  detail: string | null,
): string =>
  status === "executed" && detail && handlers.get(action)?.noteIsOutcome
    ? detail
    : OUTCOME_LINES[status](summary, detail, isStandingChoice(action));

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
      select: { status: true, action: true, summary: true, reason: true },
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
          ? [outcomeLine(a.action, a.status, a.summary, a.reason)]
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
    payload: Prisma.JsonValue;
    agent: { name: string };
  },
  outcome: Exclude<ActionApprovalStatus, "pending" | "approved">,
  decidedByName: string | null,
  detail: string | null,
  how: { chained?: boolean; resume?: string | null; quiet?: boolean } = {},
): Promise<void> => {
  const standing = isStandingChoice(approval.action);
  // Cards first - the presence lookup mirrors the post path.
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
            standing,
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

  const registered = handlers.get(approval.action);
  // Ended without executing: let the action undo what an earlier step set
  // up for it, and say the true outcome to the agent (best-effort).
  let abandonResume: string | null = null;
  if (
    !how.quiet &&
    (outcome === "rejected" || outcome === "expired" || outcome === "failed")
  ) {
    for (const listener of abandonListeners.get(approval.action) ?? []) {
      try {
        abandonResume = (await listener(approval, outcome)) ?? abandonResume;
      } catch (err) {
        log.warn(
          { approvalId: approval.id, err: String(err) },
          "action approval abandon listener failed",
        );
      }
    }
  }

  // The notice — needs a turn anchor; without one the row is still the
  // durable record and the dashboard shows it. A superseded card is quiet:
  // its newer card already says what happens next.
  if (how.quiet || !approval.conversationId || !approval.originTurnId) {
    return;
  }
  try {
    await writeConversationNotice({
      conversationId: approval.conversationId,
      turnId: approval.originTurnId,
      level: outcome === "executed" ? "info" : "warn",
      text: outcomeLine(approval.action, outcome, approval.summary, detail),
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
  if (!registered?.resumeOnExecute) return;
  // Resume only on a FINAL outcome: executed (not chained to another card),
  // or abandoned with a true outcome line. A chained pick waits for its
  // next card, whose own outcome resumes the agent.
  if (outcome === "executed" && !how.chained) {
    await resumeOriginConversation(
      approval,
      how.resume ?? resumeAfterApprovalMessage(approval.summary),
    );
  } else if (abandonResume) {
    await resumeOriginConversation(
      approval,
      `${abandonResume} Tell the person in one short line; never say it was sent.`,
    );
  }
};

/** The platform's line that wakes the agent after a card it raised was
 * decided: the person never has to type "go on". */
export const resumeAfterApprovalMessage = (summary: string): string =>
  `The person approved: ${summary}. Continue the original request.`;

/**
 * Wake the origin conversation after an executed approval: a platform turn
 * (no user) through the direct-wake door, so ONLY the agent's own direct
 * thread with the verified reader qualifies (a shared conversation has no
 * reader and is never woken). A live turn there gets it as a follow-up
 * instead. Best-effort: the outcome notice is already the durable record.
 */
const resumeOriginConversation = async (
  approval: {
    id: string;
    agentId: string;
    summary: string;
    conversationId: string | null;
  },
  message: string,
): Promise<void> => {
  if (!approval.conversationId) return;
  try {
    const conversation = await db.conversation.findFirst({
      where: {
        id: approval.conversationId,
        agentId: approval.agentId,
        direct: true,
        userId: { not: null },
      },
      select: { id: true, agent: { select: { workspaceId: true } } },
    });
    if (!conversation) return;
    const { sendConversationMessage } = await import("../follow-up-service");
    await sendConversationMessage(
      conversation.agent.workspaceId,
      conversation.id,
      message,
      {
        source: APPROVAL_RESUME_SOURCE,
        userId: null,
        directWake: { agentId: approval.agentId },
      },
    );
  } catch (err) {
    log.warn(
      { approvalId: approval.id, err: String(err) },
      "resuming the agent after an approval failed",
    );
  }
};
