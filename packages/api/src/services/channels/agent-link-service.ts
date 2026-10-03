import type {
  PeerMessageStamp,
  PeerTaskOutcome,
  PeerTaskStamp,
} from "@onecli/agent-protocol";
import { db } from "@onecli/db";
import type { Prisma } from "@onecli/db";
import { z } from "zod";
import { cleanLabel } from "../../lib/format";
import { logger } from "../../lib/logger";
import { ensureSourcedConversation } from "../conversation-service";
import { ServiceError } from "../errors";
import { peerRoster } from "./agent-peer-roster";
import { sendConversationMessage } from "../follow-up-service";
import { materializeBornDoneTurn } from "../turn-service";
import {
  ACTIVE_TURN_STATUSES,
  PEER_TASK_SOURCE,
} from "../../validations/conversation";
import {
  admitAppTurn,
  countAppTurn,
  isPastAppTurnCap,
  resetPairStreaks,
  resumeAppTurns,
} from "./app-turn-cap-service";
import {
  expireActionApprovals,
  registerActionHandler,
  requestActionApproval,
} from "./action-approval-service";
import {
  MAX_PEER_TASK_ASK_CHARS,
  MAX_PEER_TASK_REPORT_CHARS,
  claimBudgetClose,
  claimClose,
  claimExpiredTasks,
  claimPairClose,
  claimQueuedTasks,
  cleanAsk,
  findOpenTask,
  findOwnedOpenTasks,
  openOrQueueTask,
  openTaskPeers,
  peerTaskCloseLine,
  peerTaskPairRecord,
  peerTaskReportHeader,
  refundSpend,
  spendOnTask,
  type ClosedPeerTask,
  type PeerTaskRow,
} from "./peer-task-service";

const log = logger.child({ service: "agent-link" });

/**
 * AGENT-TO-AGENT (PR 5b) — one relationship, one word: "communicate".
 *
 * Two OneCLI agents talk through the control plane, never through Slack
 * (Slack forbids bot-to-bot DMs; 5a covers meeting in a shared channel).
 * The relationship is ONE row per unordered pair (`agent_links`, agentA <
 * agentB) carrying a standing decision PER SIDE — `ask` | `allow` |
 * `blocked` — because the two agents may belong to different owner groups
 * (workspaces, even organizations). Same-workspace pairs are one owner
 * group deciding twice, which the dashboard shows as one policy.
 *
 * The walk for one message, `from` -> `to`:
 *   1. the link (created `ask`/`ask` on first contact);
 *   2. `blocked` on either side -> refused with the reason, terminal;
 *   3. every side `allow` -> delivered now;
 *   4. otherwise ONE HOLD PER `ask` SIDE (the 4b action-approval primitive):
 *      each side's owners get their card ("Donna wants to talk to Ray: …")
 *      in their bell and Slack DMs; the message is delivered when the LAST
 *      required approval executes; a rejection on either side fails the
 *      other pending card loudly ("the other agent's owner declined").
 *      "Approve + always allow" sets THE DECIDER'S side to `allow`.
 *   5. at execute the live link is re-read (a block after the card wins),
 *      the 4a/5a verify-at-approve lesson.
 *
 * Delivery is a TURN on the receiver's pair conversation (`source: "agent"`,
 * `externalRef: <sender id>`, one continuous thread per pair per side),
 * framed `Donna (agent): …` — our template around a cleaned name, data
 * with provenance, never instruction authority. The sender's own pair
 * conversation records what it said as a born-done turn (`recordSentMessage`),
 * so both transcripts read as a dialogue and the dashboard's pair view can
 * draw each side's words as its own bubbles. The receiver's reply is a
 * `message_agent` back, which lands in the sender's pair conversation: the
 * return path is structural, no session routing.
 *
 * PEER TASKS (the PR after 5b): a `message_agent` from a running turn a
 * PERSON authored opens a task for that person (peer-task-service): the
 * person's words, the home conversation, a fixed budget per side, an idle
 * clock. The whole back-and-forth then runs on the pair conversations -
 * the person's conversation stays quiet - and exactly one thing comes
 * home: the agent's report (`complete_task` -> `completeTask`), or the
 * platform's close line when the task ends without one (budget spent at
 * the owner's turn close, `settlePairTurn`; idle, `sweepPeerTasks`; the
 * pair blocked or removed, `closePairTasks`). One open task per pair;
 * further asks queue and start on their own (`promoteQueuedTasks`).
 *
 * Loop backstop: a pair WITH an open task is metered by the task budget
 * (one conditional write per message, refusals that say what to do); a
 * pair WITHOUT one by the 5a app-turn cap (agent-authored turns since the
 * last human turn, a continue card for one more round). A person driving
 * either agent resets both sides' streaks, and the owner may Resume from
 * the dashboard (`resumePairConversation`).
 */

export const AGENT_LINK_POLICIES = ["ask", "allow", "blocked"] as const;
export type AgentLinkPolicy = (typeof AGENT_LINK_POLICIES)[number];

/** The registered action: approve = this side consents to THIS message. */
export const AGENT_COMMUNICATE_ACTION = "agent.communicate";

/** Longest message one agent may send another in one call. */
export const MAX_AGENT_MESSAGE_CHARS = 4000;

/**
 * Pending holds one sender may have open toward one peer. A hold posts
 * cards to the OTHER side's owners too, so an agent looping on
 * message_agent would nag a tenant that never asked for it; past this many
 * unanswered asks the tool refuses until one is decided. Deterministic, no
 * model coaching.
 */
export const MAX_PENDING_PER_PAIR = 3;

const normalizePolicy = (raw: string): AgentLinkPolicy =>
  (AGENT_LINK_POLICIES as readonly string[]).includes(raw)
    ? (raw as AgentLinkPolicy)
    : "ask";

/** The pair's canonical order: one row per unordered pair. */
const pairOf = (
  a: string,
  b: string,
): { agentAId: string; agentBId: string } =>
  a < b ? { agentAId: a, agentBId: b } : { agentAId: b, agentBId: a };

/** Which column is "mine" on the pair row. */
const sideOf = (link: { agentAId: string }, agentId: string): "A" | "B" =>
  link.agentAId === agentId ? "A" : "B";

interface LinkRow {
  id: string;
  agentAId: string;
  agentBId: string;
  policyA: string;
  policyB: string;
}

const policyOfSide = (link: LinkRow, agentId: string): AgentLinkPolicy =>
  normalizePolicy(sideOf(link, agentId) === "A" ? link.policyA : link.policyB);

/** Get-or-create the pair row (`ask`/`ask` on first contact). */
const ensureLink = async (a: string, b: string): Promise<LinkRow> => {
  const pair = pairOf(a, b);
  return db.agentLink.upsert({
    where: { agentAId_agentBId: pair },
    create: pair,
    update: {},
    select: {
      id: true,
      agentAId: true,
      agentBId: true,
      policyA: true,
      policyB: true,
    },
  });
};

/** The cap's live re-check for a peer thread: has either side blocked? */
export const isLinkBlocked = async (a: string, b: string): Promise<boolean> => {
  const link = await db.agentLink.findUnique({
    where: { agentAId_agentBId: pairOf(a, b) },
    select: {
      id: true,
      agentAId: true,
      agentBId: true,
      policyA: true,
      policyB: true,
    },
  });
  if (!link) return false;
  return (
    policyOfSide(link, a) === "blocked" || policyOfSide(link, b) === "blocked"
  );
};

/**
 * Set ONE side's standing decision. Fenced on the caller's workspace owning
 * `agentId`; the PEER must be one the dashboard can already name - a
 * same-workspace agent, or a foreign one the pair has a link row with
 * (created when it first messaged). A bare foreign id is NOT_FOUND
 * whether or not such an agent exists: the dashboard never confirms
 * another tenant's agent ids (security-onecli §1, existence is not
 * ownership). The tool door is where a foreign peer is first reached.
 */
export const setLinkPolicy = async (input: {
  workspaceId: string;
  agentId: string;
  peerAgentId: string;
  policy: AgentLinkPolicy;
  deciderUserId: string | null;
}): Promise<{ id: string; policy: AgentLinkPolicy } | null> => {
  if (input.agentId === input.peerAgentId) return null;
  const [mine, peer, existing] = await Promise.all([
    db.agent.findFirst({
      where: {
        id: input.agentId,
        workspaceId: input.workspaceId,
        kind: "hosted",
      },
      select: { id: true },
    }),
    db.agent.findFirst({
      where: {
        id: input.peerAgentId,
        workspaceId: input.workspaceId,
        kind: "hosted",
      },
      select: { id: true },
    }),
    db.agentLink.findUnique({
      where: { agentAId_agentBId: pairOf(input.agentId, input.peerAgentId) },
      select: { id: true },
    }),
  ]);
  if (!mine || (!peer && !existing)) return null;
  const link = await ensureLink(input.agentId, input.peerAgentId);
  const side = sideOf(link, input.agentId);
  await db.agentLink.update({
    where: { id: link.id },
    data:
      side === "A"
        ? { policyA: input.policy, decidedByAUserId: input.deciderUserId }
        : { policyB: input.policy, decidedByBUserId: input.deciderUserId },
  });
  // A block ends every task on the pair, both directions: the other side's
  // person hears it too (their agent can no longer be answered here).
  if (input.policy === "blocked") {
    await closePairTasks(input.agentId, input.peerAgentId, "blocked");
  }
  return { id: link.id, policy: input.policy };
};

/**
 * Forget the relationship from THIS agent's side: the pair row (so the next
 * contact starts ask/ask again for both), this agent's pair conversation
 * (its turns and events cascade), and any of this agent's pending cards
 * about the pair (expired, so the bell and Slack cards settle; a sibling
 * hold on the other agent then fails on its own approve, as a decline
 * does). The OTHER agent keeps its own conversation: its transcript is its
 * owners' record, not ours to delete. Fenced on the caller's workspace
 * owning `agentId`. Not-found-shaped.
 */
export const forgetLink = async (input: {
  workspaceId: string;
  agentId: string;
  peerAgentId: string;
}): Promise<boolean> => {
  const mine = await db.agent.findFirst({
    where: {
      id: input.agentId,
      workspaceId: input.workspaceId,
      kind: "hosted",
    },
    select: { id: true },
  });
  if (!mine) return false;
  const pair = pairOf(input.agentId, input.peerAgentId);
  const [link, conversation] = await Promise.all([
    db.agentLink.findUnique({
      where: { agentAId_agentBId: pair },
      select: { id: true },
    }),
    db.conversation.findFirst({
      where: {
        agentId: input.agentId,
        source: "agent",
        externalRef: input.peerAgentId,
      },
      select: { id: true },
    }),
  ]);
  if (!link && !conversation) return false;

  const pending = await db.actionApproval.findMany({
    where: {
      agentId: input.agentId,
      action: AGENT_COMMUNICATE_ACTION,
      status: "pending",
      OR: [
        {
          payload: { path: ["fromAgentId"], equals: input.peerAgentId },
        },
        { payload: { path: ["toAgentId"], equals: input.peerAgentId } },
      ],
    },
    select: { id: true },
  });
  if (pending.length > 0) {
    await expireActionApprovals(pending.map((p) => p.id));
  }
  // Before the pair conversation goes: the tasks' close lines record onto
  // it, and every person waiting on this pair hears why nothing came.
  await closePairTasks(input.agentId, input.peerAgentId, "removed");
  if (conversation) {
    await db.conversation.delete({ where: { id: conversation.id } });
  }
  if (link) {
    await db.agentLink.delete({ where: { id: link.id } });
  }
  return true;
};

// ── The message walk ────────────────────────────────────────────────────────

/**
 * The frozen hold (the 4b contract: written once, executed exactly). A
 * person-driven message freezes its TASK OPENER too (`classifyOrigin`), so
 * an approved question still opens the person's task at replay - the card
 * may sit for a day, and the answer must still find them. Optional: agent
 * -driven messages carry none, and holds frozen before this field read as
 * none. (5b's `homeConversationId` is the same idea one field narrower;
 * a hold frozen by 5b and approved after this ships opens a task with the
 * message itself as the ask.)
 */
const taskOpenerSchema = z.object({
  homeConversationId: z.string().min(1),
  ask: z.string().min(1).max(MAX_PEER_TASK_ASK_CHARS),
  createdByUserId: z.string().min(1).nullable(),
});
const communicatePayloadSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  text: z.string().min(1).max(MAX_AGENT_MESSAGE_CHARS),
  task: taskOpenerSchema.optional(),
  /** 5b's frozen home; read for holds that predate `task`. */
  homeConversationId: z.string().min(1).optional(),
});
type CommunicatePayload = z.infer<typeof communicatePayloadSchema>;

export type CommunicateOutcome =
  | {
      kind: "sent";
      to: string;
      /** How the message landed against the pair's task state. */
      task: "opened" | "queued" | "joined" | "ongoing" | "none";
    }
  | { kind: "held"; to: string; approvalIds: string[] };

/**
 * The tool door: `message_agent(to, text)` from `fromAgentId`. `to` resolves
 * by exact (case-insensitive) name among the sender's same-workspace peers,
 * or by agent id for a peer anywhere (Guy's "any agent" call; discovery
 * across workspaces is a later toggle). The origin conversation anchors the
 * outcome notices so the model hears the decision where it asked.
 */
export const requestCommunicate = async (input: {
  fromAgentId: string;
  to: string;
  text: string;
  originConversationId: string | null;
  originTurnId: string | null;
}): Promise<CommunicateOutcome> => {
  const from = await db.agent.findUnique({
    where: { id: input.fromAgentId },
    select: { id: true, name: true, workspaceId: true },
  });
  if (!from) throw new ServiceError("NOT_FOUND", "Agent not found");
  const peer = await resolvePeer(from, input.to);
  if (!peer) {
    const roster = await peerRoster(from.id, from.workspaceId);
    throw new ServiceError(
      "UNPROCESSABLE",
      roster.length > 0
        ? `No agent named "${cleanLabel(input.to)}". Agents you can message: ${roster.map((r) => r.name).join(", ")}.`
        : `No agent named "${cleanLabel(input.to)}", and there are no other agents in your workspace.`,
    );
  }
  const text = input.text.trim();
  if (!text) throw new ServiceError("UNPROCESSABLE", "The message is empty.");
  if (text.length > MAX_AGENT_MESSAGE_CHARS) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `The message is too long (max ${MAX_AGENT_MESSAGE_CHARS} characters).`,
    );
  }

  const link = await ensureLink(from.id, peer.id);
  const mine = policyOfSide(link, from.id);
  const theirs = policyOfSide(link, peer.id);
  if (mine === "blocked" || theirs === "blocked") {
    throw new ServiceError(
      "UNPROCESSABLE",
      mine === "blocked"
        ? `Your workspace owner has blocked messaging ${peer.name}. Don't retry.`
        : `${peer.name}'s owner has blocked messages from you. Don't retry.`,
    );
  }

  const origin = await classifyOrigin(from.id, input.originTurnId);
  const payload: CommunicatePayload = {
    fromAgentId: from.id,
    toAgentId: peer.id,
    text,
    ...(origin.kind === "person" && { task: origin.opener }),
  };
  if (mine === "allow" && theirs === "allow") {
    const landed = await deliver(payload, { origin });
    return { kind: "sent", to: peer.name, task: landed };
  }

  // The nag brake: unanswered asks from THIS sender to THIS peer, counted
  // on the sender's own holds (or the peer's, when only the peer asks).
  const pending = await db.actionApproval.count({
    where: {
      action: AGENT_COMMUNICATE_ACTION,
      status: "pending",
      expiresAt: { gt: new Date() },
      agentId: mine === "ask" ? from.id : peer.id,
      payload: { path: ["fromAgentId"], equals: from.id },
      AND: { payload: { path: ["toAgentId"], equals: peer.id } },
    },
  });
  if (pending >= MAX_PENDING_PER_PAIR) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `${peer.name}: ${pending} messages are already waiting for approval. Wait for a decision before sending more.`,
    );
  }

  // One hold per `ask` side: the sender's owners decide from the sender's
  // agent, the receiver's owners from the receiver's. Same owners on both
  // sides is the common case, in which the two cards read as one question
  // asked from each agent's point of view - and the second approve is the
  // one that delivers.
  const summary = `${cleanLabel(from.name)} wants to talk to ${cleanLabel(peer.name)}: "${cleanLabel(text, 200)}"`;
  const approvalIds: string[] = [];
  for (const side of [
    { agentId: from.id, policy: mine, anchor: true },
    { agentId: peer.id, policy: theirs, anchor: false },
  ]) {
    if (side.policy !== "ask") continue;
    const held = await requestActionApproval({
      agentId: side.agentId,
      // The outcome notice anchors on the SENDER's asking turn only; the
      // receiver has no turn yet (the message is what would create one).
      conversationId: side.anchor ? input.originConversationId : null,
      originTurnId: side.anchor ? input.originTurnId : null,
      action: AGENT_COMMUNICATE_ACTION,
      // Structurally JSON (strings and one nested object of strings) — the
      // cast bridges TS's nominal InputJsonValue only.
      payload: payload as unknown as Prisma.InputJsonValue,
      summary,
    });
    approvalIds.push(held.id);
  }
  return { kind: "held", to: peer.name, approvalIds };
};

/**
 * `to` -> the peer agent. Names resolve inside the sender's OWN workspace
 * (the roster the model was shown); an agent id resolves anywhere. Never
 * the sender itself.
 */
const resolvePeer = async (
  from: { id: string; workspaceId: string },
  to: string,
): Promise<{ id: string; name: string; workspaceId: string } | null> => {
  const wanted = to.trim();
  if (!wanted) return null;
  const select = { id: true, name: true, workspaceId: true } as const;
  const byId = await db.agent.findFirst({
    where: { id: wanted, kind: "hosted", NOT: { id: from.id } },
    select,
  });
  if (byId) return byId;
  const candidates = await db.agent.findMany({
    where: {
      workspaceId: from.workspaceId,
      kind: "hosted",
      NOT: { id: from.id },
      name: { equals: wanted, mode: "insensitive" },
    },
    select,
    take: 2,
  });
  return candidates.length === 1 ? candidates[0]! : null;
};

// ── Delivery ────────────────────────────────────────────────────────────────

/** The pair conversation on `agentId`'s side: one thread per peer. */
const pairConversation = async (
  agent: { id: string; workspaceId: string },
  peer: { id: string; name: string },
) =>
  ensureSourcedConversation(agent.workspaceId, agent.id, {
    source: "agent",
    externalRef: peer.id,
    title: cleanLabel(peer.name),
  });

/**
 * Delivery refused by the receiver's turn cap or by the task budget. Its
 * own class so BOTH doors can tell it apart from a genuine failure: the
 * tool door answers the model with the reason (a ServiceError, not "try
 * again" - a retry into a paused thread is exactly the loop the cap exists
 * to stop), and the approval handler settles the card `failed` with the
 * same words.
 */
class DeliveryRefused extends ServiceError {
  constructor(message: string) {
    super("UNPROCESSABLE", message);
  }
}

/**
 * The SENDER's record of one message it sent: a born-done turn on its own
 * pair conversation (`materializeBornDoneTurn` - a record of something that
 * already happened, never dispatchable work), the words as a `notice` event
 * stamped `peerMessage` for the dashboard's pair view. `opensTask` marks the
 * bubble that started a task for a person.
 *
 * Why a turn and not a notice on the latest turn: the FIRST message has no
 * turn on the sender's side to anchor on, and a dialogue whose opener is
 * missing is not a dialogue. The row's `message` is empty on purpose: the
 * incoming half of this turn is nothing (the agent spoke, nobody spoke to
 * it), and the pair view reads the words from the structured event, never
 * from the row. The stamp is typed beside the notice schema
 * (`peerMessageStampSchema`), so the web fold and this writer agree on one
 * shape.
 */
const recordSentMessage = async (input: {
  from: { id: string; workspaceId: string };
  to: { id: string; name: string };
  text: string;
  opensTask: boolean;
}): Promise<{ id: string }> => {
  const outbox = await pairConversation(input.from, input.to);
  await materializeBornDoneTurn(outbox.id, {
    message: "",
    source: "agent",
    events: [
      {
        type: "notice",
        level: "info",
        text: `To ${cleanLabel(input.to.name)}: ${input.text}`,
        peerMessage: {
          to: input.to.id,
          text: input.text,
          ...(input.opensTask && { opensTask: true }),
        } satisfies PeerMessageStamp,
      },
    ],
  });
  return { id: outbox.id };
};

/**
 * WHO IS BEHIND THIS MESSAGE, read off the turn the `message_agent` call
 * claims as its origin. Two answers:
 *
 *  - `person`: a turn a known person authored (`userId` set: the web chat,
 *    a linked Slack user) that is RUNNING right now on the sender, in a
 *    conversation that is not a pair thread. "A human is in the loop":
 *    the sandbox chooses which turn it claims, so an old human turn must
 *    not become a standing bypass; a running one means a person just spoke
 *    to this agent, now. The person's own words become the task's `ask`
 *    (bounded), the turn's conversation its home.
 *  - `agent`: everything else - a turn on the pair thread (the exchange
 *    itself), no origin at all (the supervisor omits the context when it
 *    cannot attribute the call, because a wrong anchor is worse than none),
 *    a Slack guest's turn, an automation turn, a stale or foreign turn.
 *    Metered by the task budget when the pair has an open task, by the
 *    cap otherwise.
 *
 * 5b had a third reading ("continuing", the peer's reply woke the sender at
 * home and the sender asked on from there). With tasks, the exchange never
 * leaves the pair thread, so there is nothing to continue from elsewhere;
 * a person adding to their question from the home is `person` and JOINS the
 * open task (`openOrQueueTask`).
 */
type MessageOrigin =
  | {
      kind: "person";
      opener: z.infer<typeof taskOpenerSchema>;
    }
  | { kind: "agent" };

const classifyOrigin = async (
  fromAgentId: string,
  originTurnId: string | null,
): Promise<MessageOrigin> => {
  if (!originTurnId) return { kind: "agent" };
  const turn = await db.turn.findFirst({
    where: {
      id: originTurnId,
      status: { in: [...ACTIVE_TURN_STATUSES] },
      userId: { not: null },
      conversation: { agentId: fromAgentId, NOT: { source: "agent" } },
    },
    select: { conversationId: true, userId: true, message: true },
  });
  if (!turn) return { kind: "agent" };
  const ask = cleanAsk(turn.message);
  if (!ask) return { kind: "agent" };
  return {
    kind: "person",
    opener: {
      homeConversationId: turn.conversationId,
      ask,
      createdByUserId: turn.userId,
    },
  };
};

/** The pair's agents by id, or null when one is gone. */
const loadPair = async (fromId: string, toId: string) => {
  const [from, to] = await Promise.all([
    db.agent.findUnique({
      where: { id: fromId },
      select: { id: true, name: true, workspaceId: true },
    }),
    db.agent.findUnique({
      where: { id: toId },
      select: { id: true, name: true, workspaceId: true },
    }),
  ]);
  return from && to ? { from, to } : null;
};

/**
 * Land the message: a system-origin turn on the receiver's pair
 * conversation, framed with the sender's cleaned name (the guest-lane
 * posture: `userId: null`, provenance in our template), which wakes the
 * receiver. Then the sender's pair conversation records the same words
 * (`recordSentMessage`), so its transcript reads as the dialogue it is.
 * Best-effort on the sender's side: the delivery already happened.
 *
 * WHAT METERS IT (see peer-task-service):
 *  - a `person` origin opens a task (or joins this home's open one, or
 *    queues behind another). An opened task's first message is the
 *    message itself; a queued task's is frozen and delivered at
 *    promotion, so this call returns without delivering. Both pair
 *    streaks reset either way: a person is in the loop.
 *  - an `agent` origin on a pair WITH an open task spends that side's
 *    task budget (`spendOnTask`), and the cap is not asked.
 *  - an `agent` origin on a pair WITHOUT a task is the 5a cap, as before.
 * The approval-replay door replays the origin frozen into the hold: a
 * person's question still opens their task a day later; an agent's message
 * still meters (budget or cap).
 *
 * Returns how the message landed against the task state (the tool door's
 * note to the model).
 */
const deliver = async (
  payload: CommunicatePayload,
  options: { origin: MessageOrigin },
): Promise<Extract<CommunicateOutcome, { kind: "sent" }>["task"]> => {
  const pair = await loadPair(payload.fromAgentId, payload.toAgentId);
  if (!pair) throw new Error("one of the agents no longer exists");
  const { from, to } = pair;

  if (options.origin.kind === "person") {
    await resetPairStreaks(from.id, to.id);
    const opened = await openOrQueueTask({
      agentId: from.id,
      peerAgentId: to.id,
      ...options.origin.opener,
      opener: payload.text,
    });
    if (opened.kind === "queue_full") {
      throw new DeliveryRefused(
        `${cleanLabel(to.name)} is busy with another task and ${opened.waiting} more are already waiting. Tell the person this cannot be asked right now.`,
      );
    }
    if (opened.kind === "queued" || opened.kind === "queued_more") {
      // Not delivered now: the task starts on its own when the pair frees
      // up (the poll arm). The sender's record still shows the ask.
      await recordSent(from, to, payload.text, opened.kind === "queued");
      return "queued";
    }
    if (opened.kind === "joined") {
      // The person added to their question: the message rides the open
      // task and spends the owner's budget like any of its messages.
      await landOnTask(opened.task, from, to, payload.text);
      return "joined";
    }
    try {
      await land(from, to, payload.text);
    } catch (err) {
      await closeTask(opened.task.id, "undeliverable");
      throw err;
    }
    await recordSent(from, to, payload.text, true);
    return "opened";
  }

  // An agent's message: the task budget when a task is open on the pair
  // (either direction), else the cap.
  const task = await findOpenTask(from.id, to.id);
  if (task) {
    await landOnTask(task, from, to, payload.text);
    return "ongoing";
  }

  await landUnderCap(from, to, payload.text);
  return "none";
};

type PairAgent = { id: string; name: string; workspaceId: string };

/** Our frame around a peer's words: `Name (agent): …`. */
const frame = (name: string, text: string): string =>
  `${cleanLabel(name)} (agent): ${text}`;

/** The receiver's turn on its pair conversation. */
const land = async (
  from: PairAgent,
  to: PairAgent,
  text: string,
): Promise<void> => {
  const inbox = await pairConversation(to, from);
  await sendConversationMessage(
    to.workspaceId,
    inbox.id,
    frame(from.name, text),
    {
      source: "agent",
      userId: null,
    },
  );
};

/** The sender's record; best-effort, the delivery already happened. */
const recordSent = async (
  from: PairAgent,
  to: PairAgent,
  text: string,
  opensTask: boolean,
): Promise<void> => {
  try {
    await recordSentMessage({ from, to, text, opensTask });
  } catch (err) {
    log.warn(
      { err: String(err), from: from.id, to: to.id },
      "sender-side agent message record failed",
    );
  }
};

/**
 * One message on an OPEN task: spend, land, record. A refused spend answers
 * the model with what to do instead - the owner reports, the peer stops. A
 * person's addition to their own question rides the owner's budget too (it
 * is the owner asking on).
 */
const landOnTask = async (
  task: PeerTaskRow,
  from: PairAgent,
  to: PairAgent,
  text: string,
): Promise<void> => {
  const owner = from.id === task.agentId;
  const spent = await spendOnTask(task, from.id, text);
  if (spent.kind === "closed") {
    // Raced a close: the pair is back under the cap. Recurse through the
    // cap door once by re-entering deliver with no task.
    await landUnderCap(from, to, text);
    return;
  }
  if (spent.kind !== "spent") {
    throw new DeliveryRefused(taskRefusal(spent.kind, owner, to.name));
  }
  try {
    await land(from, to, text);
  } catch (err) {
    await refundSpend(spent.task, from.id);
    throw err;
  }
  await recordSent(from, to, text, false);
};

/**
 * The cap path for a pair with no task (5a's cap, same primitive): the
 * receiver's pair conversation counts agent-authored turns since the last
 * human turn. At the cap the message parks in a continue card for the
 * receiver's owners; past it, silence. Decided before anything is created.
 * Shared by the plain agent branch of `deliver` and the closed-under-us
 * race in `landOnTask`.
 */
const landUnderCap = async (
  from: PairAgent,
  to: PairAgent,
  text: string,
): Promise<void> => {
  const inbox = await pairConversation(to, from);
  const framed = frame(from.name, text);
  const verdict = await admitAppTurn({
    agentId: to.id,
    conversationId: inbox.id,
    source: "agent",
    message: framed,
    speaker: { kind: "agent", agentId: from.id },
  });
  if (verdict !== "admit") {
    throw new DeliveryRefused(
      verdict === "pause"
        ? `${cleanLabel(to.name)} paused this conversation until a person continues it. Don't retry; you will hear when it resumes.`
        : `${cleanLabel(to.name)} has paused this conversation. Don't retry.`,
    );
  }
  await sendConversationMessage(to.workspaceId, inbox.id, framed, {
    source: "agent",
    userId: null,
  });
  await countAppTurn(inbox.id);
  await recordSent(from, to, text, false);
};

/** The words a refused task spend answers the model with. */
const taskRefusal = (
  kind: "sender_spent" | "peer_spent",
  owner: boolean,
  peerName: string,
): string => {
  const peer = cleanLabel(peerName);
  if (!owner) {
    return `You have no replies left in this task. Don't retry; ${peer} will report to the person with what it has.`;
  }
  return kind === "sender_spent"
    ? `You have no messages left in this task. Call complete_task now with the report for the person, using what you have.`
    : `${peer} has no replies left in this task, so a question now would go unanswered. Call complete_task now with the report for the person, using what you have.`;
};

// ── Tasks: complete, close, promote ─────────────────────────────────────────

/**
 * `complete_task(report)` from `agentId`: the agent's report to the person
 * who opened the task. WHICH task: the one on the pair the calling
 * conversation belongs to when the call came from a pair thread (the
 * normal case - the interview runs there); otherwise the agent's single
 * open task, or, when it owns several, the one with `peer` named; else a
 * refusal that names them. Fenced: the task must be OWED by this agent (a
 * peer cannot complete the owner's task), and the close is a conditional
 * flip so a double call answers "already closed" rather than posting twice.
 */
export const completeTask = async (input: {
  agentId: string;
  report: string;
  originConversationId: string | null;
  peer: string | null;
}): Promise<{ peerName: string }> => {
  const report = input.report.trim();
  if (!report) throw new ServiceError("UNPROCESSABLE", "The report is empty.");
  if (report.length > MAX_PEER_TASK_REPORT_CHARS) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `The report is too long (max ${MAX_PEER_TASK_REPORT_CHARS} characters).`,
    );
  }
  const task = await resolveOwnedTask(input);
  const closed = await claimClose(task.id, "reported");
  if (!closed) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This task is already closed; nothing more can be reported on it.",
    );
  }
  await materializePeerTaskClose(closed, report);
  await promoteQueuedTasks();
  return { peerName: closed.peerName };
};

const resolveOwnedTask = async (input: {
  agentId: string;
  originConversationId: string | null;
  peer: string | null;
}): Promise<PeerTaskRow> => {
  if (input.originConversationId) {
    const conversation = await db.conversation.findFirst({
      where: {
        id: input.originConversationId,
        agentId: input.agentId,
        source: "agent",
      },
      select: { externalRef: true },
    });
    if (conversation?.externalRef) {
      const task = await findOpenTask(input.agentId, conversation.externalRef);
      if (task && task.agentId === input.agentId) return task;
      const peer = await db.agent.findUnique({
        where: { id: conversation.externalRef },
        select: { name: true },
      });
      throw new ServiceError(
        "UNPROCESSABLE",
        task
          ? `The open task with ${cleanLabel(peer?.name ?? "this agent")} is theirs to complete, not yours: they are asking on a person's behalf. Answer with message_agent.`
          : `You have no open task with ${cleanLabel(peer?.name ?? "this agent")}. Nothing to report on.`,
      );
    }
  }
  const owned = await findOwnedOpenTasks(input.agentId);
  if (owned.length === 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "You have no open task to report on. complete_task is for a task a person gave you for another agent.",
    );
  }
  const peers = await db.agent.findMany({
    where: { id: { in: owned.map((task) => task.peerAgentId) } },
    select: { id: true, name: true },
  });
  const names = peers.map((p) => cleanLabel(p.name)).join(" and ");
  if (input.peer) {
    // Named: exactly that task, or a refusal - never "the other one".
    const wanted = input.peer.trim().toLowerCase();
    const match = peers.find(
      (p) => p.id === input.peer || p.name.toLowerCase() === wanted,
    );
    const task = match && owned.find((t) => t.peerAgentId === match.id);
    if (task) return task;
    throw new ServiceError(
      "UNPROCESSABLE",
      `You have no open task with ${cleanLabel(input.peer)}. Your open tasks are with ${names}.`,
    );
  }
  if (owned.length === 1) return owned[0]!;
  throw new ServiceError(
    "UNPROCESSABLE",
    `You have open tasks with ${names}. Say which with the peer argument.`,
  );
};

/**
 * A task closed: the person's line (the report, or the platform's close
 * line), then the pair record. The person's conversation is re-fenced to
 * the owner agent at write time (a home is the owner's own conversation by
 * construction; the fence is what keeps that true), and a home that no
 * longer exists is a silent no-op inside `materializeBornDoneTurn` - though
 * the FK cascade makes that a race, not a state.
 */
const materializePeerTaskClose = async (
  closed: ClosedPeerTask,
  report: string | null,
): Promise<void> => {
  const home = await db.conversation.findFirst({
    where: { id: closed.task.homeConversationId, agentId: closed.task.agentId },
    select: { id: true },
  });
  if (home) {
    await materializeBornDoneTurn(home.id, {
      message: peerTaskReportHeader(closed.peerName),
      source: PEER_TASK_SOURCE,
      events: [{ type: "text", text: report ?? peerTaskCloseLine(closed) }],
    });
  } else {
    log.warn(
      { taskId: closed.task.id, agentId: closed.task.agentId },
      "peer task home is gone; report dropped",
    );
  }
  try {
    const pair = await db.conversation.findFirst({
      where: {
        agentId: closed.task.agentId,
        source: "agent",
        externalRef: closed.task.peerAgentId,
      },
      select: { id: true },
    });
    if (pair) {
      await materializeBornDoneTurn(pair.id, {
        message: "",
        source: "agent",
        events: [
          {
            type: "notice",
            level: "info",
            text: peerTaskPairRecord(closed),
            peerTask: { outcome: closed.outcome } satisfies PeerTaskStamp,
          },
        ],
      });
    }
  } catch (err) {
    log.warn(
      { err: String(err), taskId: closed.task.id },
      "peer task pair record failed",
    );
  }
};

/** Close one task with a backstop outcome and tell the person. */
const closeTask = async (
  taskId: string,
  outcome: Exclude<PeerTaskOutcome, "reported">,
): Promise<void> => {
  const closed = await claimClose(taskId, outcome);
  if (closed) await materializePeerTaskClose(closed, null);
};

/**
 * The budget backstop, at the close of a turn on a pair conversation (the
 * turn-service hook): the owner had the peer's last word, a side is out of
 * messages, and no report came. Then promote, since a close frees the
 * pair. Failure-isolated by the caller.
 */
export const settlePairTurn = async (conversation: {
  agentId: string;
  externalRef: string | null;
}): Promise<void> => {
  const closed = await claimBudgetClose(conversation);
  if (!closed) return;
  await materializePeerTaskClose(closed, null);
  await promoteQueuedTasks();
};

/**
 * The poll arm: idle tasks close, then queued tasks whose pair is free
 * start. Each row settles on its own so one broken tenant cannot starve
 * the rest; empty almost always (two indexed probes).
 */
export const sweepPeerTasks = async (): Promise<void> => {
  const expired = await claimExpiredTasks();
  for (const closed of expired) {
    await materializePeerTaskClose(closed, null).catch((err) =>
      log.warn(
        { err: String(err), taskId: closed.task.id },
        "peer task expiry line failed",
      ),
    );
  }
  await promoteQueuedTasks();
};

/**
 * Start every queued task whose pair is free: deliver the frozen opener as
 * the task's first message. A delivery that fails closes the task
 * `undeliverable` (with its line), so a queued ask is never lost silently.
 */
const promoteQueuedTasks = async (): Promise<void> => {
  const opened = await claimQueuedTasks();
  for (const task of opened) {
    const pair = await loadPair(task.agentId, task.peerAgentId);
    if (!pair) {
      await closeTask(task.id, "undeliverable");
      continue;
    }
    try {
      await land(pair.from, pair.to, task.opener);
    } catch (err) {
      log.warn(
        { err: String(err), taskId: task.id },
        "queued peer task could not be delivered",
      );
      await closeTask(task.id, "undeliverable");
    }
  }
};

/**
 * The pair was blocked (either side) or removed (this side): every open or
 * queued task on it ends, and each person hears why. Called by the policy
 * and forget doors; the approval handler's live re-check refuses new
 * messages on its own.
 */
const closePairTasks = async (
  agentId: string,
  peerAgentId: string,
  outcome: "blocked" | "removed",
): Promise<void> => {
  const closed = await claimPairClose(agentId, peerAgentId, outcome);
  for (const item of closed) {
    await materializePeerTaskClose(item, null).catch((err) =>
      log.warn(
        { err: String(err), taskId: item.task.id },
        "peer task pair-close line failed",
      ),
    );
  }
  if (closed.length > 0) await promoteQueuedTasks();
};

// ── Approval replay ─────────────────────────────────────────────────────────

/**
 * Approve = this side consents. Deliver only once BOTH sides have: re-read
 * the live link first (a block since the card wins), then the sibling hold
 * for the same message on the other agent. Fenced on the approval's own
 * agent: the payload must name it as one of the two.
 *
 * WHICH approve delivers is decided by ORDER, not by status: the two cards
 * may be approved within the same instant, and at handler time each still
 * reads the other as `approved` (flipped, not yet `executed`) - a rule of
 * "the other is approved, so it will deliver" makes BOTH defer and loses
 * the message. So the LATER decision (by `decidedAt`, id as tiebreak)
 * delivers and the earlier one defers; both handlers compute the same
 * answer from rows already written before either ran (the flip precedes
 * the handler), so exactly one delivers, sequential or concurrent.
 */
registerActionHandler(
  AGENT_COMMUNICATE_ACTION,
  async (approval) => {
    const payload = communicatePayloadSchema.parse(approval.payload);
    if (
      approval.agentId !== payload.fromAgentId &&
      approval.agentId !== payload.toAgentId
    ) {
      throw new Error("this approval does not belong to either agent");
    }
    const link = await ensureLink(payload.fromAgentId, payload.toAgentId);
    if (
      policyOfSide(link, payload.fromAgentId) === "blocked" ||
      policyOfSide(link, payload.toAgentId) === "blocked"
    ) {
      throw new Error("one side has blocked this conversation since");
    }
    const [mine, sibling] = await Promise.all([
      db.actionApproval.findUniqueOrThrow({
        where: { id: approval.id },
        select: { decidedAt: true },
      }),
      // The sibling hold for the SAME message (same frozen payload) on the
      // other agent, if that side also asked.
      db.actionApproval.findFirst({
        where: {
          id: { not: approval.id },
          action: AGENT_COMMUNICATE_ACTION,
          agentId:
            approval.agentId === payload.fromAgentId
              ? payload.toAgentId
              : payload.fromAgentId,
          payload: { equals: approval.payload as Prisma.InputJsonValue },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, decidedAt: true },
      }),
    ]);
    if (sibling) {
      // Still undecided: its approve is the one that delivers.
      if (sibling.status === "pending") return;
      // Declined or expired: this approve cannot deliver alone. Failed: the
      // other side WAS the deliverer and delivery refused (the cap); a
      // second attempt would only re-ask the same refusal.
      if (sibling.status === "failed") {
        throw new Error("delivery already failed on the other side");
      }
      if (sibling.status !== "approved" && sibling.status !== "executed") {
        throw new Error(
          sibling.status === "expired"
            ? "the other agent's card expired"
            : "the other agent's owner declined",
        );
      }
      // Both consented. The later decision delivers.
      if (!decidedAfter(mine.decidedAt, approval.id, sibling)) return;
    }
    // A PERSON's question stays a person's question: the opener frozen into
    // the hold opens their task at replay exactly as an immediate delivery
    // would. A hold frozen by 5b carries only the home; the message itself
    // stands in for the ask.
    const opener =
      payload.task ??
      (payload.homeConversationId
        ? {
            homeConversationId: payload.homeConversationId,
            ask: cleanAsk(payload.text),
            createdByUserId: null,
          }
        : null);
    await deliver(payload, {
      origin: opener ? { kind: "person", opener } : { kind: "agent" },
    });
  },
  {
    // "Approve + always allow": THE DECIDER'S side flows from now on. The
    // other side's standing is untouched - one relationship, two owners.
    alwaysAllow: async (approval, deciderUserId) => {
      const payload = communicatePayloadSchema.parse(approval.payload);
      const link = await ensureLink(payload.fromAgentId, payload.toAgentId);
      const side = sideOf(link, approval.agentId);
      await db.agentLink.update({
        where: { id: link.id },
        data:
          side === "A"
            ? { policyA: "allow", decidedByAUserId: deciderUserId }
            : { policyB: "allow", decidedByBUserId: deciderUserId },
      });
    },
  },
);

/** Is decision (`at`, `id`) strictly later than the sibling's? Same instant
 *  falls to the id order, so the answer is total and both sides agree. */
const decidedAfter = (
  at: Date | null,
  id: string,
  sibling: { id: string; decidedAt: Date | null },
): boolean => {
  const mine = at?.getTime() ?? 0;
  const theirs = sibling.decidedAt?.getTime() ?? 0;
  return mine !== theirs ? mine > theirs : id > sibling.id;
};

// ── The dashboard surface (agent contacts routes) ──────────────────────────

export interface AgentPeer {
  agentId: string;
  name: string;
  /** The peer's workspace name when it is not the caller's own; null for a
   * same-workspace peer (the common case, needs no qualifier). */
  workspaceName: string | null;
  /** THIS agent's side of the relationship. */
  myPolicy: AgentLinkPolicy;
  /** The peer's side. */
  theirPolicy: AgentLinkPolicy;
  /** The pair conversation on THIS agent's side, once they have talked. */
  conversationId: string | null;
  /**
   * THIS side's pair conversation is past the 5a turn cap: every message
   * from the peer is silence until a person resumes it (the peer row's
   * Resume, or a person driving either agent). False with no conversation.
   */
  paused: boolean;
  /** A peer task is open on this pair (either agent asking for a person):
   * the two are working, and a report is on its way to someone. */
  taskOpen: boolean;
}

/**
 * A person continues THIS agent's pair conversation with `peerAgentId`
 * past the turn cap (the dashboard's Resume). Fenced on the caller's
 * workspace owning `agentId`; the pair conversation is looked up by the
 * pair, never by a client-supplied id. `false` = not-found (a foreign
 * agent, or a pair that has never talked - there is nothing to resume).
 * The cap service owns the how (`resumeAppTurns`).
 */
export const resumePairConversation = async (input: {
  workspaceId: string;
  agentId: string;
  peerAgentId: string;
  deciderUserId: string;
}): Promise<boolean> => {
  const conversation = await db.conversation.findFirst({
    where: {
      agentId: input.agentId,
      source: "agent",
      externalRef: input.peerAgentId,
      agent: { workspaceId: input.workspaceId, kind: "hosted" },
    },
    select: { id: true },
  });
  if (!conversation) return false;
  return resumeAppTurns({
    agentId: input.agentId,
    conversationId: conversation.id,
    deciderUserId: input.deciderUserId,
  });
};

/**
 * Every agent this one may talk to, with the pair's standing: the
 * workspace's other hosted agents (linked or not) plus any linked peer from
 * elsewhere. Workspace-fenced at the query; a foreign workspace reads [].
 */
export const listPeers = async (input: {
  workspaceId: string;
  agentId: string;
}): Promise<AgentPeer[]> => {
  const me = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!me) return [];
  const [roster, links, conversations] = await Promise.all([
    peerRoster(input.agentId, input.workspaceId),
    db.agentLink.findMany({
      where: {
        OR: [{ agentAId: input.agentId }, { agentBId: input.agentId }],
      },
      select: {
        id: true,
        agentAId: true,
        agentBId: true,
        policyA: true,
        policyB: true,
        agentA: {
          select: {
            id: true,
            name: true,
            workspace: { select: { name: true } },
          },
        },
        agentB: {
          select: {
            id: true,
            name: true,
            workspace: { select: { name: true } },
          },
        },
      },
    }),
    db.conversation.findMany({
      where: { agentId: input.agentId, source: "agent" },
      select: { id: true, externalRef: true, appTurnStreak: true },
    }),
  ]);
  const conversationByPeer = new Map(
    conversations
      .filter((c) => c.externalRef !== null)
      .map((c) => [c.externalRef!, c]),
  );
  const peerIds = new Set<string>([
    ...roster.map((r) => r.id),
    ...links.map((link) =>
      link.agentAId === input.agentId ? link.agentBId : link.agentAId,
    ),
  ]);
  const working = await openTaskPeers(input.agentId, [...peerIds]);
  const pairState = (peerId: string) => {
    const conversation = conversationByPeer.get(peerId);
    return {
      conversationId: conversation?.id ?? null,
      paused: isPastAppTurnCap(conversation?.appTurnStreak ?? 0),
      taskOpen: working.has(peerId),
    };
  };
  const peers = new Map<string, AgentPeer>();
  for (const r of roster) {
    peers.set(r.id, {
      agentId: r.id,
      name: r.name,
      workspaceName: null,
      myPolicy: "ask",
      theirPolicy: "ask",
      ...pairState(r.id),
    });
  }
  for (const link of links) {
    const other = link.agentAId === input.agentId ? link.agentB : link.agentA;
    const existing = peers.get(other.id);
    const entry: AgentPeer = {
      agentId: other.id,
      name: other.name,
      workspaceName: existing ? null : other.workspace.name,
      myPolicy: policyOfSide(link, input.agentId),
      theirPolicy: policyOfSide(link, other.id),
      ...pairState(other.id),
    };
    peers.set(other.id, entry);
  }
  return [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
};
