import { db } from "@onecli/db";
import {
  ingestDirectMessage,
  ingestGroupMessage,
  ingestGroupInvite,
  ingestGroupLeave,
  ingestSessionStop,
  ingestSystemNotice,
  type IngestOutcome,
  type GroupInviteOutcome,
  type SessionStopOutcome,
} from "../../channel-ingestion-service";
import {
  markPresenceRemoved,
  revokePresenceUserTokens,
} from "../../agent-channel-service";
import {
  attachFollowUpReceipt,
  attachTurnReceipt,
} from "../../turn-receipt-service";
import { interpretSlackEvent, type SlackDoorCall } from "./interpret";
import { isNoReply } from "@onecli/agent-protocol/text";
import { resolveLlmCallKey } from "../../../llm-direct-call";
import {
  JUDGE_DEADLINE_MS,
  judgeReply,
  type JudgeVerdict,
  type ReplyPlacement,
} from "../../../judges/reply-judge";
import { cleanLine, readRoomTranscript } from "./room-transcript";
import { logger } from "../../../../lib/logger";

const log = logger.child({ component: "slack-dispatch" });

/**
 * Raw Slack event → interpreted door call → outcome, for BOTH transports:
 * the HTTP events route and the socket adapter's ingest endpoint hand events
 * here so classification, the echo guard, and the fences run identically
 * whichever way the event arrived.
 */

export type SlackDispatchResult =
  | { kind: "ignored"; reason: string }
  | {
      kind: "message";
      call: Extract<SlackDoorCall, { door: "direct" | "group" }>;
      outcome: IngestOutcome;
    }
  | {
      kind: "invite";
      call: Extract<SlackDoorCall, { door: "invite" }>;
      outcome: GroupInviteOutcome;
    }
  | {
      kind: "stop";
      call: Extract<SlackDoorCall, { door: "stop" }>;
      outcome: SessionStopOutcome;
    };

export const dispatchSlackEvent = async (input: {
  presenceId: string;
  identityRef: string | null;
  event: unknown;
  eventId: string;
}): Promise<SlackDispatchResult> => {
  const call = interpretSlackEvent(input.event, {
    botUserId: input.identityRef,
  });

  if (call.door === "ignore") {
    return { kind: "ignored", reason: call.reason };
  }

  // No `email` is threaded through: the ingestion doors resolve the speaker
  // control-plane-side (existing link, else a provider-verified lookup with
  // the presence's own bot token). A caller-supplied email would be an
  // impersonation vector.
  if (call.door === "invite") {
    const outcome = await ingestGroupInvite({
      agentChannelId: input.presenceId,
      inviterExternalUserId: call.inviterExternalUserId,
      // The joined channel - the reach grant's subject (the owner-DM knock).
      channel: call.channel,
      eventId: input.eventId,
    });
    return { kind: "invite", call, outcome };
  }

  if (call.door === "leave") {
    // The bot was removed from the channel: presence cleanup, nothing owed
    // back (the bot cannot post there anymore). Ignored-shaped on the wire
    // by design - the adapter has nothing to do.
    await ingestGroupLeave({
      agentChannelId: input.presenceId,
      channel: call.channel,
      eventId: input.eventId,
    });
    return { kind: "ignored", reason: "left-channel-cleaned" };
  }

  if (call.door === "system_notice") {
    // Slack's own system user DMed the bot (e.g. "You have been removed
    // from #x"). Never a speaker - nothing is owed back (the IM is
    // read-only) and no person knock is planted. Used only as a hint:
    // re-verify the presence's channel memberships with Slack (detached).
    await ingestSystemNotice({
      agentChannelId: input.presenceId,
      eventId: input.eventId,
    });
    return { kind: "ignored", reason: "slack-system-notice" };
  }

  if (call.door === "user-tokens-revoked") {
    // Slack names user ids, never tokens: exactly those people's read
    // tokens minted through THIS app go (grants cascade).
    await revokePresenceUserTokens(input.presenceId, call.externalUserIds);
    return { kind: "ignored", reason: "user-tokens-revoked" };
  }

  if (call.door === "removed") {
    // The APP was removed from the workspace: the presence flips to disabled
    // (dashboard says so, the agent's doc says so, a re-attach resumes it).
    // Ignored-shaped on the wire like `leave` - the bot token is dead, so
    // there is nothing the adapter could post. Idempotent: Slack sends
    // app_uninstalled and tokens_revoked in either order.
    await markPresenceRemoved(input.presenceId, call.reason);
    return { kind: "ignored", reason: `presence-removed:${call.reason}` };
  }

  if (call.door === "stop") {
    // The native Stop: the same authorized abort the web uses, as the
    // clicker. A refusal is owed back to the clicker alone (the caller posts
    // it ephemerally); everything else answers in the thread on its own
    // (the close posts "Stopped.").
    const outcome = await ingestSessionStop({
      agentChannelId: input.presenceId,
      externalUserId: call.externalUserId,
      channel: call.channel,
      threadTs: call.threadTs,
      eventId: input.eventId,
    });
    return { kind: "stop", call, outcome };
  }

  if (call.door === "direct") {
    const outcome = await ingestDirectMessage({
      agentChannelId: input.presenceId,
      externalUserId: call.externalUserId,
      externalThreadId: call.externalThreadId,
      text: call.text,
      files: call.files,
      // The DM thread this was typed in, when it was typed in one. The
      // conversation stays the DM's single row; only the answer's address
      // narrows to the thread.
      sourceThreadId: call.replyThreadTs,
      eventId: input.eventId,
    });
    receiptForAcceptedTurn(input.presenceId, call, outcome);
    return { kind: "message", call, outcome };
  }

  // Group follow-ups (no mention) count only inside threads the agent
  // already joined — an existing link is the membership test. A mention
  // (`app_mention`) always counts and is what CREATES the link.
  //
  // APPS must mention to be heard (PR 5a, the round-2 lesson). A person
  // talking in the agent's thread is talking to the agent — membership IS
  // the addressing signal. A bot posting in a thread carries no such
  // signal (it posts wherever it is wired), so the tag is the only honest
  // one: exactly the requirement every top-level channel message already
  // has. Without this, two agents in one thread could never stop — "I'm
  // done" is itself a message, and every message woke the other side.
  if (call.speakerKind === "app" && !call.isMention) {
    return { kind: "ignored", reason: "app-unaddressed" };
  }
  // A top-level message with no mention: heard only where a person promoted
  // the agent to be this channel's point of contact.
  if (call.overheard) return ingestOverheard(input, call, "channel-chatter");
  if (!(await isMentionOrJoinedThread(input, call))) {
    // A reply inside a thread the agent never joined: in a PROMOTED channel
    // it is still the room talking (often the person answering the agent's
    // own threaded reply). Anywhere else, other people's thread chatter
    // stays private.
    return ingestOverheard(input, call, "unjoined-thread-chatter");
  }

  const outcome = await ingestGroupMessage({
    agentChannelId: input.presenceId,
    externalUserId: call.externalUserId,
    speakerKind: call.speakerKind,
    externalThreadId: call.externalThreadId,
    title: null,
    text: call.text,
    files: call.files,
    eventId: input.eventId,
  });
  receiptForAcceptedTurn(input.presenceId, call, outcome);
  return { kind: "message", call, outcome };
};

/**
 * The "seen" mark, detached: an ACCEPTED turn (created cleanly, a door
 * failure's error IS its answer, posted by the completion pass) gets an
 * AI-chosen reaction on the triggering message. An accepted mid-run
 * FOLLOW-UP gets a waiting mark of its own on its message (one mark per
 * message, never moved: the mark flips to "read" when the run picks the
 * message up, and comes off with the answer). Fire-and-forget by design:
 * nothing here may delay the ack or change the outcome, and the receipt
 * ledger is what makes the later clear restart-safe.
 */
const receiptForAcceptedTurn = (
  presenceId: string,
  call: Extract<SlackDoorCall, { door: "direct" | "group" }>,
  outcome: IngestOutcome,
  /** The answer goes in the CHANNEL, not a thread: the mark is the
   * reaction on the message (a loader would open a thread nobody wants). */
  inChannel = false,
): void => {
  const replyThreadTs = inChannel ? null : call.replyThreadTs;
  if (outcome.kind === "followUp") {
    void attachFollowUpReceipt({
      presenceId,
      followUpTurnId: outcome.turn.id,
      channel: call.replyChannel,
      messageTs: call.messageTs,
    });
    return;
  }
  if (outcome.kind !== "turn" || outcome.turn.errorCode) return;
  void attachTurnReceipt({
    presenceId,
    turnId: outcome.turn.id,
    channel: call.replyChannel,
    messageTs: call.messageTs,
    // The session root the agent-flavor loader is keyed by.
    //
    // Anything THREADED — a group mention, or a DM reply typed inside a
    // thread — carries the thread root it will answer in. A top-level DM has
    // no thread, but Slack still requires a `thread_ts` to scope an agent
    // session (`thread_ts_required` otherwise), and the user's own message IS
    // a valid root: the session hangs off the message that started the
    // exchange, which is exactly the turn this receipt marks.
    //
    // This is what gives DMs the native loader at all. Before it they fell
    // through to the emoji reaction, which is a "seen" mark rather than a
    // "working" one — the agent looked idle for the whole turn.
    threadTs: inChannel ? null : (call.replyThreadTs ?? call.messageTs),
    // Where a narration card may go: the real reply thread — the group
    // thread, the DM thread the person typed in, or null at the top level of
    // a DM. Kept apart from the session root above so an UNTHREADED DM's
    // card stays inline instead of opening a thread per turn.
    replyThreadTs,
    // No thread to hang a loader on ⇒ the card carries the whole signal.
    // Derived from the reply address rather than the door: a DM reply typed
    // INSIDE a thread has one, and it should light up like any other thread.
    unthreaded: replyThreadTs === null,
    text: call.text,
  });
};

/**
 * `app_mention` events always pass (they are addressed to the agent). A plain
 * thread message passes only when the thread is already linked.
 */
const isMentionOrJoinedThread = async (
  input: { presenceId: string; event: unknown },
  call: Extract<SlackDoorCall, { door: "group" }>,
): Promise<boolean> => {
  const type = (input.event as { type?: string }).type;
  if (type === "app_mention") return true;
  const link = await db.channelThreadLink.findUnique({
    where: {
      agentChannelId_externalThreadId: {
        agentChannelId: input.presenceId,
        externalThreadId: call.externalThreadId,
      },
    },
    select: { id: true },
  });
  return link !== null;
};

/**
 * The point-of-contact room: ONE conversation per channel for everything the
 * agent overhears there (a bare channel id - the address codec reads it as
 * "the channel, top level"). Each answer lands where the turn's
 * `sourceThreadId` points: the channel itself, or a thread.
 */
const roomThreadId = (channel: string): string => channel;

/**
 * A message the agent was not @mentioned in, in a thread it has not joined
 * or at the top level: heard only in a PROMOTED channel, answered in the
 * room conversation. `unheard` is the ignore reason everywhere else (the
 * pre-promotion behavior for that kind of message).
 */
const ingestOverheard = async (
  input: { presenceId: string; eventId: string },
  call: GroupCall,
  unheard: string,
): Promise<SlackDispatchResult> => {
  const admitted = await admitOverheard(input.presenceId, call);
  if (!admitted.ok) {
    return {
      kind: "ignored",
      reason: admitted.reason === "not-promoted" ? unheard : admitted.reason,
    };
  }
  // A message inside a thread is answered in that thread. A top-level one is
  // answered in the channel (null: the room's own address) unless the judge
  // read this room as one that threads.
  const inThread = call.replyThreadTs !== call.messageTs;
  const sourceThreadId = inThread
    ? call.replyThreadTs
    : admitted.placement === "thread"
      ? call.messageTs
      : null;
  const outcome = await ingestGroupMessage({
    agentChannelId: input.presenceId,
    externalUserId: call.externalUserId,
    speakerKind: call.speakerKind,
    externalThreadId: roomThreadId(call.replyChannel),
    sourceThreadId,
    // Not clearly the agent's: a speaker it may not answer is ignored
    // quietly, never told to link an account in front of the room.
    overheard: !admitted.addressed,
    title: null,
    text: call.text,
    files: call.files,
    eventId: input.eventId,
  });
  // Only a message that is clearly the agent's (its name, or the judge's
  // say-so) gets the "seen" mark: a mark on every message in the room is
  // noise, and the agent may well stay silent. An in-channel answer opens no
  // thread, so its mark is the reaction alone.
  if (admitted.addressed) {
    receiptForAcceptedTurn(
      input.presenceId,
      call,
      outcome,
      sourceThreadId === null,
    );
  }
  return { kind: "message", call, outcome };
};

type GroupCall = Extract<SlackDoorCall, { door: "group" }>;

type Admission =
  | { ok: true; addressed: boolean; placement?: ReplyPlacement }
  | { ok: false; reason: string };

/**
 * May the agent HEAR this message? Only in a channel a person promoted
 * (listen = "all") that answers someone, and only within the channel's
 * hourly budget: every answer the agent was not @mentioned for counts and
 * is capped, so a busy channel can never become a runaway bill (@mentions
 * never reach here). Everything after this - the channel gate, the identity
 * lane, person blocks, the app-turn cap - runs unchanged in the group door.
 */
const admitOverheard = async (
  presenceId: string,
  call: GroupCall,
): Promise<Admission> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: presenceId },
    select: {
      agentId: true,
      integrationId: true,
      identityRef: true,
      identityName: true,
      agent: {
        select: {
          name: true,
          workspaceId: true,
          instructions: true,
          workspace: { select: { organizationId: true } },
        },
      },
    },
  });
  if (!presence) return { ok: false, reason: "no-presence" };
  // Dynamic: the reach service imports the provider registry, which imports
  // this module (a static import would be a cycle).
  const { resolveSpaceListen, isSettled, OVERHEARD_TURNS_PER_HOUR } =
    await import("../../agent-reach-service");
  const space = await resolveSpaceListen({
    agentId: presence.agentId,
    integrationId: presence.integrationId,
    externalRef: call.replyChannel,
  });
  if (!space || space.listen !== "all" || !isSettled(space.state)) {
    return { ok: false, reason: "not-promoted" };
  }
  // Checked BEFORE the judge, so a channel past its budget costs no model
  // call either.
  if (
    (await roomTurnsThisHour(presenceId, call.replyChannel)) >=
    OVERHEARD_TURNS_PER_HOUR
  ) {
    return { ok: false, reason: "overheard-budget" };
  }
  // Called by NAME ("rafi, can you...") is the agent's even with no verdict;
  // its PLACEMENT still comes from the judge when one answers in time.
  const byName = callsByName(call.text, [
    presence.agent.name,
    presence.identityName,
  ]);
  // A fast model reads the room and decides whether the message is for the
  // agent, and where to answer. "Not for the agent" drops it before any
  // agent turn. No verdict (no usable key, slow, refused) leaves the agent
  // to decide on its own, answering in the channel.
  const verdict = await judgeOverheard(presenceId, presence, call);
  if (byName) {
    return {
      ok: true,
      addressed: true,
      ...(verdict?.reply && { placement: verdict.placement }),
    };
  }
  if (verdict === null) return { ok: true, addressed: false };
  if (!verdict.reply) return { ok: false, reason: "judged-not-for-agent" };
  return { ok: true, addressed: true, placement: verdict.placement };
};

/** The room conversation, when the agent has spoken in it before. */
const roomConversationId = async (
  presenceId: string,
  channel: string,
): Promise<string | null> => {
  const room = await db.channelThreadLink.findUnique({
    where: {
      agentChannelId_externalThreadId: {
        agentChannelId: presenceId,
        externalThreadId: roomThreadId(channel),
      },
    },
    select: { conversationId: true },
  });
  return room?.conversationId ?? null;
};

/** Turns the room conversation started this past hour: the budget's count.
 * Mentions live in their own thread conversations and never count here. */
const roomTurnsThisHour = async (
  presenceId: string,
  channel: string,
): Promise<number> => {
  const conversationId = await roomConversationId(presenceId, channel);
  if (!conversationId) return 0;
  return db.turn.count({
    where: {
      conversationId,
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
};

/** How much of the room the judge reads: enough to see how people talk
 * here (who threads, who talks in the channel), like scrolling up. */
const JUDGE_HISTORY = 40;

/** The agent's last few real answers in the room: what it is part of. */
const recentAnswers = async (
  presenceId: string,
  channel: string,
): Promise<string[]> => {
  const conversationId = await roomConversationId(presenceId, channel);
  if (!conversationId) return [];
  const turns = await db.turn.findMany({
    where: { conversationId, status: "done" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      message: true,
      events: {
        where: { type: "text" },
        orderBy: { seq: "desc" },
        take: 1,
        select: { payload: true },
      },
    },
  });
  return turns
    .map((turn) => ({
      asked: turn.message,
      said: String(
        (turn.events[0]?.payload as { text?: unknown } | null)?.text ?? "",
      ),
    }))
    .filter(({ said }) => said.trim() !== "" && !isNoReply(said))
    .slice(0, 3)
    .reverse()
    .map(
      ({ asked, said }) =>
        `to "${cleanLine(asked, 120)}" it answered "${cleanLine(said, 160)}"`,
    );
};

const judgeOverheard = async (
  presenceId: string,
  presence: {
    agentId: string;
    identityRef: string | null;
    agent: {
      name: string;
      workspaceId: string;
      instructions: string | null;
      workspace: { organizationId: string };
    };
  },
  call: GroupCall,
): Promise<JudgeVerdict | null> => {
  const signal = AbortSignal.timeout(JUDGE_DEADLINE_MS);
  const work = async (): Promise<JudgeVerdict | null> => {
    const resolved = await resolveLlmCallKey(
      { id: presence.agentId, workspaceId: presence.agent.workspaceId },
      presence.agent.workspace.organizationId,
    );
    if (!resolved.ok) return null;
    const { key } = resolved;
    const tagged = [...call.text.matchAll(/<@([A-Z0-9]+)>/g)].map(
      (match) => match[1] ?? "",
    );
    const [room, answers] = await Promise.all([
      readRoomTranscript({
        presenceId,
        channel: call.replyChannel,
        limit: JUDGE_HISTORY,
        excludeTs: call.messageTs,
        alsoName: [call.externalUserId, ...tagged],
      }),
      recentAnswers(presenceId, call.replyChannel),
    ]);
    if (!room) return null;
    const name = presence.agent.name;
    // A thread reply continues the agent's exchange only when the agent is
    // in THAT thread (its root's repliers include the agent).
    const inThread = call.replyThreadTs !== call.messageTs;
    const withAgent =
      inThread &&
      presence.identityRef !== null &&
      room.repliersOf(call.replyThreadTs).includes(presence.identityRef);
    const where = !inThread
      ? ""
      : withAgent
        ? ` [in a thread where ${name} is talking]`
        : " [in a thread]";
    return judgeReply({
      key,
      signal,
      agent: { id: presence.agentId, name },
      instructions: presence.agent.instructions,
      recentAnswers: answers,
      transcript: [
        ...room.lines,
        `${room.render(call.externalUserId, call.text)}${where}`,
      ],
    });
  };
  // The race returns at the deadline even while a DB or Slack read is still
  // out; the signal cancels every model call the judge has in flight.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.info({ channel: call.replyChannel }, "reply judge: deadline");
      resolve(null);
    }, JUDGE_DEADLINE_MS);
  });
  const verdict = await Promise.race([
    work().catch((err: unknown) => {
      log.info({ err: String(err) }, "reply judge: no verdict");
      return null;
    }),
    deadline,
  ]);
  clearTimeout(timer);
  return verdict;
};

/**
 * Does this message call the agent by name? A whole-word, case-insensitive
 * match of the agent's name or its Slack handle ("rafi, can you" / "thanks
 * Rafi"), so a name inside another word ("giraffe") never counts. Names
 * shorter than 3 characters are ignored: too likely to be a common word.
 */
export const callsByName = (
  text: string,
  names: ReadonlyArray<string | null | undefined>,
): boolean => {
  const hay = text.toLowerCase();
  return names.some((raw) => {
    const name = (raw ?? "").trim().toLowerCase();
    if (name.length < 3) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`,
      "u",
    ).test(hay);
  });
};
