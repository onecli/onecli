import { db, Prisma } from "@onecli/db";
import type { PeerTaskOutcome } from "@onecli/agent-protocol";
import { cleanLabel } from "../../lib/format";
import { logger } from "../../lib/logger";
import { stripControl } from "../../lib/text";

const log = logger.child({ service: "peer-task" });

/**
 * PEER TASKS (the PR after 5b) — the STATE of one thing a person asked an
 * agent that the agent took to another agent. This module owns the rows and
 * the words; it never creates a turn. The materialization doors (the report
 * into the person's conversation, the close line, the pair record) live in
 * turn-service, and the walk that decides when to call what lives in
 * agent-link-service — so this file imports neither and both import it.
 *
 * The model, in the industry's words (A2A): a person's ask is a stateful
 * TASK with a server-minted id and a lifecycle; an agent's message is a
 * stateless MESSAGE. Here:
 *
 *  - OPEN: `message_agent` from a running human-authored turn opens a task
 *    (`openOrQueueTask`): the person's words (`ask`, bounded), the home
 *    conversation the report lands in, the agent's first message frozen as
 *    `opener`. ONE OPEN TASK PER PAIR, either direction: the partial unique
 *    index `peer_tasks_one_open_per_pair` is the seam, so a second ask on a
 *    busy pair is born `queued` (FIFO, depth-bounded) and starts on its own
 *    when the open one closes (the poll arm in agent-link-service).
 *  - SPEND: every message on a pair with an open task spends that side's
 *    budget with ONE conditional write (`spendOnTask`) - no read-then-write,
 *    no lock held across a model call. The owner cannot send once the peer
 *    has no replies left (it would wait forever), so the refusal it hears
 *    says to report instead. Each spend refreshes `expiresAt`: the TTL is
 *    an IDLE clock, so a slow interview that is still moving is not cut
 *    off, and total life stays bounded by budget x idle.
 *  - CLOSE: `complete_task` (the agent's report), or a backstop - budget
 *    spent with nothing in flight (`claimBudgetClose`, at the owner's turn
 *    close), the idle TTL (`claimExpiredTasks`, the poll arm), the pair
 *    blocked or removed (`claimPairClose`). Every close is a conditional
 *    status flip, so exactly one path ever materializes the person's line.
 *
 * Fencing: rows are looked up by the pair the CALLER's agent is on, never
 * by a client-supplied id; the home conversation is the owner agent's own
 * (written by `classifyOrigin` from a fenced turn) and re-checked by the
 * materializer. Two agents may live in different workspaces: the peer's
 * context never carries the person's raw words, only that a person asked.
 */

/** Messages each side may send within one task. The house rule, same as
 * the app-turn cap: enough for a real back-and-forth, cheap to burn. */
export const PEER_TASK_MESSAGE_BUDGET = 6;
/** Idle minutes before a task closes without a report. */
export const PEER_TASK_IDLE_MINUTES = 30;
/** Queued tasks per pair beyond the open one; a fourth ask is refused. */
export const PEER_TASK_QUEUE_DEPTH = 3;
/** The person's words as the task keeps them. */
export const MAX_PEER_TASK_ASK_CHARS = 1000;
/** The report `complete_task` accepts. */
export const MAX_PEER_TASK_REPORT_CHARS = 4000;
/** A frozen opener, after any same-home additions while queued: the
 * message ceiling the tool door already enforces per message. */
export const MAX_PEER_TASK_OPENER_CHARS = 4000;
/** How much of the peer's last message a close line quotes. */
export const PEER_TASK_LAST_REPLY_CHARS = 500;
/** Rows one sweep pass claims (expiries, promotions). */
export const PEER_TASK_SWEEP_LIMIT = 20;

/** The row shape every caller here reads. */
export const peerTaskSelect = {
  id: true,
  agentId: true,
  peerAgentId: true,
  homeConversationId: true,
  createdByUserId: true,
  ask: true,
  opener: true,
  status: true,
  outcome: true,
  agentSent: true,
  peerSent: true,
  awaitingPeer: true,
  lastPeerText: true,
  openedAt: true,
  expiresAt: true,
} satisfies Prisma.PeerTaskSelect;
export type PeerTaskRow = Prisma.PeerTaskGetPayload<{
  select: typeof peerTaskSelect;
}>;

/** The unordered pair, sorted: the index key whichever side opened. */
export const peerTaskPair = (
  a: string,
  b: string,
): { pairAId: string; pairBId: string } =>
  a < b ? { pairAId: a, pairBId: b } : { pairAId: b, pairBId: a };

const idleDeadline = (): Date =>
  new Date(Date.now() + PEER_TASK_IDLE_MINUTES * 60_000);

/**
 * The person's words, as platform-authored context will carry them: one
 * line (newlines become spaces FIRST, so "ship by\nFriday" keeps its word
 * boundary - `cleanLabel` would drop the newline as a control character),
 * control characters out, whitespace collapsed, bounded.
 */
export const cleanAsk = (raw: string): string =>
  cleanLabel(stripControl(raw).replace(/\n/g, " "), MAX_PEER_TASK_ASK_CHARS);

/** The peer's last message, kept for the close line: same treatment. */
const cleanLastReply = (raw: string): string =>
  cleanLabel(stripControl(raw).replace(/\n/g, " "), PEER_TASK_LAST_REPLY_CHARS);

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// ── Lookups ─────────────────────────────────────────────────────────────────

/** The open task on the pair, if any. One indexed read. */
export const findOpenTask = async (
  agentId: string,
  peerAgentId: string,
): Promise<PeerTaskRow | null> =>
  db.peerTask.findFirst({
    where: { ...peerTaskPair(agentId, peerAgentId), status: "open" },
    select: peerTaskSelect,
  });

/** The open tasks `agentId` OWES a report on (the `complete_task` fallback
 * when the call has no attributable origin; the Contacts page). */
export const findOwnedOpenTasks = async (
  agentId: string,
): Promise<PeerTaskRow[]> =>
  db.peerTask.findMany({
    where: { agentId, status: "open" },
    orderBy: { openedAt: "asc" },
    select: peerTaskSelect,
  });

/** Which of `peerIds` this agent has an open task with (either side). One
 * query over the pair index; N is the roster size (<= 50). */
export const openTaskPeers = async (
  agentId: string,
  peerIds: readonly string[],
): Promise<Set<string>> => {
  if (peerIds.length === 0) return new Set();
  const rows = await db.peerTask.findMany({
    where: {
      status: "open",
      OR: peerIds.map((peerId) => peerTaskPair(agentId, peerId)),
    },
    select: { agentId: true, peerAgentId: true },
  });
  return new Set(
    rows.map((row) =>
      row.agentId === agentId ? row.peerAgentId : row.agentId,
    ),
  );
};

/** The open task whose report lands in `homeConversationId`, for the
 * standing line in the person's conversation. */
export const findOpenTaskForHome = async (
  homeConversationId: string,
): Promise<PeerTaskRow | null> =>
  db.peerTask.findFirst({
    where: { homeConversationId, status: "open" },
    select: peerTaskSelect,
  });

// ── Open / queue ────────────────────────────────────────────────────────────

export type OpenTaskOutcome =
  | { kind: "opened"; task: PeerTaskRow }
  | { kind: "queued"; task: PeerTaskRow }
  /** The pair already carries this home's open task: the person added to
   * their question, and the message rides the same task. */
  | { kind: "joined"; task: PeerTaskRow }
  /** This home's task is still QUEUED: the addition is folded into the
   * frozen opener, so the peer hears the whole question when it starts. */
  | { kind: "queued_more"; task: PeerTaskRow }
  | { kind: "queue_full"; waiting: number };

/**
 * A person-driven message from `agentId` to `peerAgentId`: open a task, or
 * join the one this home already has open, or queue behind another. The
 * open INSERT carries `agentSent: 1` and `awaitingPeer: true` because the
 * opener IS the first message; the caller delivers it right after (and
 * closes the task `undeliverable` if that fails). A queued task freezes the
 * opener and is delivered at promotion instead.
 */
export const openOrQueueTask = async (input: {
  agentId: string;
  peerAgentId: string;
  homeConversationId: string;
  createdByUserId: string | null;
  ask: string;
  opener: string;
}): Promise<OpenTaskOutcome> => {
  const pair = peerTaskPair(input.agentId, input.peerAgentId);
  const open = await findOpenTask(input.agentId, input.peerAgentId);
  if (
    open &&
    open.agentId === input.agentId &&
    open.homeConversationId === input.homeConversationId
  ) {
    return { kind: "joined", task: open };
  }
  // The same home asking on while its task still waits in line: one task,
  // one opener, extended - never a second queue entry for one question.
  // Guarded on `queued`: a promotion racing this write wins, and the
  // addition then falls through to the open path on the caller's retry.
  const waitingHere = await db.peerTask.findFirst({
    where: {
      ...pair,
      status: "queued",
      agentId: input.agentId,
      homeConversationId: input.homeConversationId,
    },
    select: { id: true, opener: true },
  });
  if (waitingHere) {
    const extended = await db.peerTask.updateMany({
      where: { id: waitingHere.id, status: "queued" },
      data: {
        opener: `${waitingHere.opener}\n\n${input.opener}`.slice(
          0,
          MAX_PEER_TASK_OPENER_CHARS,
        ),
      },
    });
    if (extended.count === 1) {
      const task = await db.peerTask.findUniqueOrThrow({
        where: { id: waitingHere.id },
        select: peerTaskSelect,
      });
      return { kind: "queued_more", task };
    }
  }
  const base = {
    ...pair,
    agentId: input.agentId,
    peerAgentId: input.peerAgentId,
    homeConversationId: input.homeConversationId,
    createdByUserId: input.createdByUserId,
    ask: input.ask,
    opener: input.opener,
  };
  if (!open) {
    try {
      const task = await db.peerTask.create({
        data: {
          ...base,
          status: "open",
          agentSent: 1,
          awaitingPeer: true,
          openedAt: new Date(),
          expiresAt: idleDeadline(),
        },
        select: peerTaskSelect,
      });
      return { kind: "opened", task };
    } catch (err) {
      // Lost the one-open race: another task opened on this pair between
      // the read and the insert. Fall through to the queue.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  const waiting = await db.peerTask.count({
    where: { ...pair, status: "queued" },
  });
  if (waiting >= PEER_TASK_QUEUE_DEPTH) return { kind: "queue_full", waiting };
  const task = await db.peerTask.create({
    data: { ...base, status: "queued" },
    select: peerTaskSelect,
  });
  return { kind: "queued", task };
};

/**
 * The poll arm's promotion claim: flip ONE queued task on a pair with no
 * open task to `open`. The flip is the atomic seam - a racer loses on the
 * status guard (0 rows) or on the one-open index (P2002) and the row simply
 * stays queued for the next pass. Returns the tasks that flipped; the
 * caller delivers each opener.
 */
export const claimQueuedTasks = async (): Promise<PeerTaskRow[]> => {
  // One candidate per pair per pass: the oldest queued task on a pair that
  // has no open task right now.
  const candidates = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ON (q.pair_a_id, q.pair_b_id) q.id
    FROM peer_tasks q
    WHERE q.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM peer_tasks o
        WHERE o.status = 'open'
          AND o.pair_a_id = q.pair_a_id
          AND o.pair_b_id = q.pair_b_id
      )
    ORDER BY q.pair_a_id, q.pair_b_id, q.created_at
    LIMIT ${PEER_TASK_SWEEP_LIMIT}
  `;
  const opened: PeerTaskRow[] = [];
  for (const { id } of candidates) {
    try {
      const flipped = await db.peerTask.updateMany({
        where: { id, status: "queued" },
        data: {
          status: "open",
          agentSent: 1,
          awaitingPeer: true,
          openedAt: new Date(),
          expiresAt: idleDeadline(),
        },
      });
      if (flipped.count === 0) continue;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
    const task = await db.peerTask.findUnique({
      where: { id },
      select: peerTaskSelect,
    });
    if (task) opened.push(task);
  }
  return opened;
};

// ── Spend ───────────────────────────────────────────────────────────────────

export type SpendOutcome =
  | { kind: "spent"; task: PeerTaskRow }
  /** The sender's own budget is gone. */
  | { kind: "sender_spent"; task: PeerTaskRow }
  /** The owner may still have messages, but the peer has no replies left:
   * a question now could never be answered. */
  | { kind: "peer_spent"; task: PeerTaskRow }
  /** Closed between the caller's read and this write. */
  | { kind: "closed" };

/**
 * One message from `fromAgentId` on the open task: one conditional write.
 * The owner's guard also requires the peer to have a reply left; the
 * peer's guard is its own count only. Refreshes the idle clock. `text` is
 * kept (bounded) for the peer side, so a close without a report can still
 * quote what the peer last said.
 */
export const spendOnTask = async (
  task: PeerTaskRow,
  fromAgentId: string,
  text: string,
): Promise<SpendOutcome> => {
  const owner = fromAgentId === task.agentId;
  const guard = owner
    ? {
        agentSent: { lt: PEER_TASK_MESSAGE_BUDGET },
        peerSent: { lt: PEER_TASK_MESSAGE_BUDGET },
      }
    : { peerSent: { lt: PEER_TASK_MESSAGE_BUDGET } };
  const updated = await db.peerTask.updateMany({
    where: { id: task.id, status: "open", ...guard },
    data: owner
      ? {
          agentSent: { increment: 1 },
          awaitingPeer: true,
          expiresAt: idleDeadline(),
        }
      : {
          peerSent: { increment: 1 },
          awaitingPeer: false,
          lastPeerText: cleanLastReply(text),
          expiresAt: idleDeadline(),
        },
  });
  const fresh = await db.peerTask.findUnique({
    where: { id: task.id },
    select: peerTaskSelect,
  });
  if (!fresh || fresh.status !== "open") return { kind: "closed" };
  if (updated.count === 1) return { kind: "spent", task: fresh };
  // Refused: say which side ran out. The owner's own count first - "you
  // are out" is the more actionable of the two.
  if (owner && fresh.agentSent >= PEER_TASK_MESSAGE_BUDGET) {
    return { kind: "sender_spent", task: fresh };
  }
  if (!owner && fresh.peerSent >= PEER_TASK_MESSAGE_BUDGET) {
    return { kind: "sender_spent", task: fresh };
  }
  return { kind: "peer_spent", task: fresh };
};

/** A spend whose delivery then failed: give the message back. Best-effort
 * and bounded at zero; the idle clock stays refreshed, which is harmless. */
export const refundSpend = async (
  task: PeerTaskRow,
  fromAgentId: string,
): Promise<void> => {
  const owner = fromAgentId === task.agentId;
  await db.peerTask.updateMany({
    where: {
      id: task.id,
      status: "open",
      ...(owner ? { agentSent: { gt: 0 } } : { peerSent: { gt: 0 } }),
    },
    // The owner's message never reached the peer: nothing is owed back.
    data: owner
      ? { agentSent: { decrement: 1 }, awaitingPeer: false }
      : { peerSent: { decrement: 1 } },
  });
};

// ── Close ───────────────────────────────────────────────────────────────────

/** A task that just closed, with the names its person-facing line needs. */
export interface ClosedPeerTask {
  task: PeerTaskRow;
  outcome: PeerTaskOutcome;
  agentName: string;
  peerName: string;
}

const CLOSABLE = ["open", "queued"] as const;

/**
 * THE CLOSE CLAIM: flip `task` to done with `outcome` if it is still open
 * (or queued). Exactly one caller wins, so exactly one line reaches the
 * person. Null when someone else closed it first.
 */
export const claimClose = async (
  taskId: string,
  outcome: PeerTaskOutcome,
): Promise<ClosedPeerTask | null> => {
  const flipped = await db.peerTask.updateMany({
    where: { id: taskId, status: { in: [...CLOSABLE] } },
    data: { status: "done", outcome, closedAt: new Date() },
  });
  if (flipped.count === 0) return null;
  const task = await db.peerTask.findUnique({
    where: { id: taskId },
    select: {
      ...peerTaskSelect,
      agent: { select: { name: true } },
      peerAgent: { select: { name: true } },
    },
  });
  if (!task) return null; // cascaded away under us - nothing to tell anyone
  const { agent, peerAgent, ...row } = task;
  return {
    task: row,
    outcome,
    agentName: cleanLabel(agent.name),
    peerName: cleanLabel(peerAgent.name),
  };
};

/**
 * The budget backstop, asked at the close of a turn on a PAIR conversation:
 * if the conversation's agent OWNS the open task with that peer, nothing is
 * in flight (the peer has answered), and a side is out of messages, the
 * task ends `budget` - the owner had the peer's last word and neither asked
 * on nor reported. A task with budget left is left alone: the idle clock is
 * the backstop for a model that simply forgot.
 */
export const claimBudgetClose = async (conversation: {
  agentId: string;
  externalRef: string | null;
}): Promise<ClosedPeerTask | null> => {
  if (!conversation.externalRef) return null;
  const task = await db.peerTask.findFirst({
    where: {
      agentId: conversation.agentId,
      peerAgentId: conversation.externalRef,
      status: "open",
      awaitingPeer: false,
      OR: [
        { agentSent: { gte: PEER_TASK_MESSAGE_BUDGET } },
        { peerSent: { gte: PEER_TASK_MESSAGE_BUDGET } },
      ],
    },
    select: { id: true },
  });
  if (!task) return null;
  return claimClose(task.id, "budget");
};

/** The idle sweep: open tasks past their clock, bounded per pass. */
export const claimExpiredTasks = async (): Promise<ClosedPeerTask[]> => {
  const due = await db.peerTask.findMany({
    where: { status: "open", expiresAt: { lt: new Date() } },
    orderBy: { expiresAt: "asc" },
    take: PEER_TASK_SWEEP_LIMIT,
    select: { id: true },
  });
  const closed: ClosedPeerTask[] = [];
  for (const { id } of due) {
    const result = await claimClose(id, "expired").catch((err) => {
      log.warn({ err: String(err), taskId: id }, "peer task expiry failed");
      return null;
    });
    if (result) closed.push(result);
  }
  return closed;
};

/** Every open or queued task on the pair, closed `blocked` or `removed`. */
export const claimPairClose = async (
  agentId: string,
  peerAgentId: string,
  outcome: Extract<PeerTaskOutcome, "blocked" | "removed">,
): Promise<ClosedPeerTask[]> => {
  const rows = await db.peerTask.findMany({
    where: {
      ...peerTaskPair(agentId, peerAgentId),
      status: { in: [...CLOSABLE] },
    },
    select: { id: true },
  });
  const closed: ClosedPeerTask[] = [];
  for (const { id } of rows) {
    const result = await claimClose(id, outcome);
    if (result) closed.push(result);
  }
  return closed;
};

// ── Words ───────────────────────────────────────────────────────────────────

/** The caption over the agent's report (and over a close line) in the
 * person's conversation: where these words came from. */
export const peerTaskReportHeader = (peerName: string): string =>
  `After talking with ${peerName}`;

/**
 * The person's line when a task ends WITHOUT a report - platform-voiced,
 * bounded, and never empty-handed: the peer's last message rides along
 * when there is one (AutoGen's `last_msg` summary, the honest fallback).
 * `reported` never comes here: the report is the agent's own words.
 */
export const peerTaskCloseLine = (closed: ClosedPeerTask): string => {
  const { agentName: agent, peerName: peer, task } = closed;
  const head = {
    budget: `${agent} used up its messages with ${peer} before reporting back.`,
    expired: `${agent} did not report back after ${PEER_TASK_IDLE_MINUTES} minutes without progress.`,
    blocked: `Messaging between ${agent} and ${peer} was blocked before ${agent} could report back.`,
    removed: `${peer} was removed from ${agent}’s contacts before ${agent} could report back.`,
    undeliverable: `${agent} could not reach ${peer} to ask about this.`,
    reported: `${agent} reported back.`,
  }[closed.outcome];
  const tail = task.lastPeerText
    ? `${peer}’s last message: “${task.lastPeerText}”`
    : task.openedAt
      ? `${peer} never answered.`
      : `The task never started.`;
  return `${head}\n\n${tail}`;
};

/** The pair conversation's record of the task ending (the dialog's last
 * line in the pair view). */
export const peerTaskPairRecord = (closed: ClosedPeerTask): string =>
  ({
    reported: "Reported back to the person.",
    budget: "Out of messages; the task closed without a report.",
    expired: "No progress for a while; the task closed without a report.",
    blocked: "Messaging was blocked; the task closed.",
    removed: "The contact was removed; the task closed.",
    undeliverable: "The message could not be delivered; the task closed.",
  })[closed.outcome];

/**
 * The OWNER's standing context on its pair conversation while a task is
 * open: what the person asked, the budget left, and the one way out. The
 * person's words are DATA in quotes, never an instruction the model should
 * follow from here.
 */
export const ownerTaskContext = (
  task: PeerTaskRow,
  peerName: string,
): string => {
  const mine = Math.max(0, PEER_TASK_MESSAGE_BUDGET - task.agentSent);
  const theirs = Math.max(0, PEER_TASK_MESSAGE_BUDGET - task.peerSent);
  return [
    `You are on a task for a person. They asked you, in another conversation: “${task.ask}”. You are talking with ${peerName} about it here; the person does not see this conversation.`,
    `You can send ${mine} more ${mine === 1 ? "message" : "messages"}; ${peerName} can reply ${theirs} more ${theirs === 1 ? "time" : "times"}.`,
    `When you have what the person needs, call complete_task with the report written for the person; only that report reaches them. If ${peerName} needs something only the person can answer, put the question in the report and complete the task.`,
  ].join(" ");
};

/** The PEER's standing context: a person is behind these questions, and
 * how many replies it has. Never the person's words - they belong to the
 * owner's workspace. */
export const peerTaskContext = (
  task: PeerTaskRow,
  ownerName: string,
): string => {
  const theirs = Math.max(0, PEER_TASK_MESSAGE_BUDGET - task.peerSent);
  return `${ownerName} is asking on behalf of a person. You can reply ${theirs} more ${theirs === 1 ? "time" : "times"} in this task; answer as completely as you can.`;
};

/** The standing line in the PERSON's conversation while its task is open. */
export const homeTaskContext = (task: PeerTaskRow, peerName: string): string =>
  `You have a task open with ${peerName} for this conversation: “${task.ask}”. Its answers arrive in your conversation with ${peerName}, and your report lands here on its own when you call complete_task there. If the person adds to the question, message_agent passes it to ${peerName} within the same task.`;
