import { db, type Prisma } from "@onecli/db";
import { cleanLabel } from "@onecli/agent-protocol/text";
import { getCrypto } from "../../providers";
import { dashboardUrl } from "../../lib/dashboard-url";
import { logger } from "../../lib/logger";
import {
  PLATFORM_AUTHORED_SOURCES,
  TURN_FAILED_RAW_ERROR_MESSAGE,
  isPlatformAuthoredSource,
  isRawErrorPayload,
} from "../../validations/conversation";
import { dmReachableOwners } from "./agent-reach-service";
import { channelProvider, isChannelProviderId } from "./registry";

const log = logger.child({ component: "turn-failure-notice" });

/**
 * FAILED CHANNEL TURNS, MADE VISIBLE.
 *
 * A turn that fails in a channel conversation used to end at the generic
 * line in the thread: the person who asked saw it, nobody else did. The
 * owner learned about it from a screenshot, and the agent had no idea at
 * all. Two doors close that gap, both platform-composed:
 *
 *  - THE OWNER ALERT (`notifyOwnersOfFailedTurn`): the workspace owners who
 *    are DM-reachable on the agent's channel integration (the approval
 *    cards' own audience, `dmReachableOwners`) get one DM from the agent:
 *    where it failed, when, the canonical reason, and a link to the run.
 *    Throttled per agent, best-effort, never in the close path's way.
 *  - THE AGENT NOTE (`buildFailedRepliesNote`): a human turn in the failed
 *    conversation, or in a workspace owner's own direct thread with the
 *    agent, carries a short note listing the recent failures there, so the
 *    agent can acknowledge the miss instead of carrying on as if it never
 *    happened.
 *
 * Only failures a person was LEFT WITH count: a channel conversation (it
 * has a thread link), a turn a person typed (never an automation run or a
 * platform-authored greeting or resume), status `failed`. Aborts are the
 * person's own stop.
 */

/** At most one owner alert per agent per window. A provider outage fails
 * every conversation at once; one DM says it, thirty bury it. */
const OWNER_ALERT_WINDOW_MS = 30 * 60 * 1000;

/** How far back the agent's note looks, and how many failures it lists. */
export const FAILED_REPLIES_WINDOW_MS = 24 * 60 * 60 * 1000;
const FAILED_REPLIES_MAX = 3;

/** The person's words, as the note and the alert quote them. */
const QUOTE_MAX_CHARS = 160;
/** The reason line. Canonical copy is short; a raw sentence is clamped. */
const REASON_MAX_CHARS = 300;

/** Prisma's `notIn` wants a mutable array; one definition of the set. */
const platformAuthoredSourceList: string[] = [...PLATFORM_AUTHORED_SOURCES];

/** A failed turn a person typed: never an automation run, a greeting or a
 * desktop resume. Shared by both doors so they count the same failures. */
const failedPersonTurn = {
  status: "failed",
  source: { notIn: platformAuthoredSourceList },
} satisfies Prisma.TurnWhereInput;

/** The reason a person can read, never a provider payload: the canonical
 * copy when a code was classified (the turn row already stores it), the
 * generic line for a raw body. An uncoded failure often stores no row error
 * at all (its detail lives only in the transcript `error` event), so the
 * caller passes that event's message as the fallback, the mirror's own
 * precedence. */
const failureReasonOf = (error: string | null): string => {
  if (!error) return "no error detail was recorded";
  if (isRawErrorPayload(error)) return TURN_FAILED_RAW_ERROR_MESSAGE;
  return cleanLabel(error, REASON_MAX_CHARS);
};

/** The turns' durable `error` event messages, newest per turn. One query for
 * the whole batch. */
const errorEventsOf = async (
  turnIds: readonly string[],
): Promise<Map<string, string>> => {
  if (turnIds.length === 0) return new Map();
  const events = await db.turnEvent.findMany({
    where: { turnId: { in: [...turnIds] }, type: "error" },
    orderBy: { seq: "desc" },
    select: { turnId: true, payload: true },
  });
  const out = new Map<string, string>();
  for (const event of events) {
    if (out.has(event.turnId)) continue;
    const payload = event.payload;
    const message =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload.message
        : undefined;
    if (typeof message === "string" && message.trim()) {
      out.set(event.turnId, message);
    }
  }
  return out;
};

/**
 * The stored message, quoted: one printable line, clamped, so a crafted
 * message can never open a new line of instructions in platform voice.
 * Channel ingestion frames a speaker's words behind a name prefix; quoting
 * the whole stored line is fine (it is what the agent saw).
 */
const quoteOf = (message: string): string =>
  cleanLabel(message, QUOTE_MAX_CHARS);

/**
 * Sender-written text inside the owner alert, with no link label. The alert
 * is markdown the provider renders, so a message like
 * `[Re-login](https://…)` would arrive as a live link under a label of the
 * sender's choosing, in the agent's voice, in the DMs of the people who hold
 * the workspace. Without the brackets the words stay readable and any URL
 * shows as itself. Dropped, not escaped: a backslash escape renders
 * literally in some providers' dialects (the reach card's rule for chosen
 * labels).
 */
const plainOf = (text: string): string => text.replace(/[[\]]/g, "");

/** Where it happened. A channel gets its stored label when the space grant
 * recorded one ("#ops"): provider text anyone with rights can set, so
 * clamped. */
const whereOf = async (input: {
  agentId: string;
  integrationId: string;
  provider: string;
  kind: string;
  externalThreadId: string;
}): Promise<string> => {
  if (input.kind === "direct") return "a direct message";
  if (!isChannelProviderId(input.provider)) return "a channel";
  const space = channelProvider(input.provider).reach?.spaceOf(
    input.externalThreadId,
  );
  if (!space) return "a channel";
  const grant = await db.agentReachGrant.findUnique({
    where: {
      agentId_integrationId_subjectKind_externalRef: {
        agentId: input.agentId,
        integrationId: input.integrationId,
        subjectKind: "space",
        externalRef: space,
      },
    },
    select: { subjectLabel: true },
  });
  return cleanLabel(grant?.subjectLabel ?? "") || "a channel";
};

/** One line of UTC time, stable across hosts (the owner reads it in Slack,
 * which shows its own local stamp on the DM anyway). */
const stampOf = (at: Date): string =>
  `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The agent's failed runs in Activity: where a channel turn's question,
 * error and trace are readable (the agent's chat page shows only the
 * viewer's own direct thread, never a channel conversation). */
const failedRunsUrl = (agentId: string, workspaceId: string): string | null => {
  try {
    const query = new URLSearchParams({
      tab: "runs",
      agent: agentId,
      view: "failed",
    });
    return dashboardUrl(`/activity?${query.toString()}`, { workspaceId });
  } catch {
    // A misconfigured origin costs the link, never the alert.
    return null;
  }
};

/** The alert text. The template is ours and every dynamic field was clamped
 * (and the sender-written ones made plain) by its producer. Markdown: the
 * provider renders it natively. A null quote (a direct message: that
 * person's private thread) omits the words. */
const ownerAlertText = (input: {
  agentName: string;
  where: string;
  at: Date;
  quote: string | null;
  reason: string;
  runsUrl: string | null;
}): string =>
  [
    `${cleanLabel(input.agentName) || "Your agent"} couldn't answer a message in ${input.where} (${stampOf(input.at)}).`,
    ...(input.quote === null ? [] : [`Message: "${input.quote}"`]),
    `Reason: ${input.reason}`,
    input.runsUrl
      ? `The person saw an error and has no answer yet. Details: ${input.runsUrl}`
      : "The person saw an error and has no answer yet.",
  ].join("\n");

/**
 * DM the agent's DM-reachable workspace owners about one failed channel
 * turn. Best-effort and self-contained: every read is its own, every failure
 * is logged and swallowed, so the turn close that called it can never be
 * failed by Slack or a misconfigured origin.
 *
 * The throttle is a DB fact, not a timer: if another of this agent's
 * channel turns FAILED earlier inside the window, an alert for it already
 * went out (or was skipped for the same reason), so this one stays quiet.
 * Ordered by when each turn FAILED, the moment its own alert was raised: two
 * overlapping turns that fail out of their start order still cost one DM.
 */
export const notifyOwnersOfFailedTurn = async (
  turnId: string,
): Promise<void> => {
  try {
    const turn = await db.turn.findUnique({
      where: { id: turnId },
      select: {
        status: true,
        source: true,
        message: true,
        error: true,
        finishedAt: true,
        conversation: {
          select: {
            agentId: true,
            agent: { select: { name: true, workspaceId: true } },
            threadLink: {
              select: {
                kind: true,
                externalThreadId: true,
                agentChannel: {
                  select: {
                    integrationId: true,
                    provider: true,
                    status: true,
                    credentials: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const link = turn?.conversation.threadLink;
    if (
      !turn?.finishedAt ||
      turn.status !== "failed" ||
      isPlatformAuthoredSource(turn.source) ||
      !link
    ) {
      return;
    }
    const presence = link.agentChannel;
    if (
      presence.status !== "active" ||
      !presence.credentials ||
      !isChannelProviderId(presence.provider)
    ) {
      return;
    }

    const failedAt = turn.finishedAt;
    const earlier = await db.turn.findFirst({
      where: {
        ...failedPersonTurn,
        // A sweep fails a whole batch in one statement, at one instant: the
        // id breaks that tie, so the batch still costs exactly one DM.
        OR: [
          {
            finishedAt: {
              gte: new Date(failedAt.getTime() - OWNER_ALERT_WINDOW_MS),
              lt: failedAt,
            },
          },
          { finishedAt: failedAt, id: { lt: turnId } },
        ],
        conversation: {
          agentId: turn.conversation.agentId,
          threadLink: { isNot: null },
        },
      },
      select: { id: true },
    });
    if (earlier) return;

    const { agentId } = turn.conversation;
    const { workspaceId, name: agentName } = turn.conversation.agent;
    const owners = await dmReachableOwners(workspaceId, presence.integrationId);
    if (owners.length === 0) return;

    const where = await whereOf({
      agentId,
      integrationId: presence.integrationId,
      provider: presence.provider,
      kind: link.kind,
      externalThreadId: link.externalThreadId,
    });
    const fallback = turn.error
      ? null
      : ((await errorEventsOf([turnId])).get(turnId) ?? null);
    const text = ownerAlertText({
      agentName,
      where,
      at: failedAt,
      // A direct thread is that person's own: the owners learn that a DM
      // failed and why, never what was said in it. Runs never lists another
      // person's direct thread either, so a link there would show nothing.
      quote: link.kind === "direct" ? null : plainOf(quoteOf(turn.message)),
      reason: plainOf(failureReasonOf(turn.error ?? fallback)),
      runsUrl:
        link.kind === "direct" ? null : failedRunsUrl(agentId, workspaceId),
    });

    const credentialsJson = await getCrypto().decrypt(presence.credentials);
    const provider = channelProvider(presence.provider);
    for (const owner of owners) {
      try {
        await provider.sendMessage({
          credentialsJson,
          to: { kind: "person", ref: owner.externalUserId },
          text,
        });
      } catch (err) {
        log.warn(
          { err: String(err), agentId, userId: owner.userId },
          "failed-turn owner alert did not post",
        );
      }
    }
  } catch (err) {
    log.warn({ err: String(err), turnId }, "failed-turn owner alert skipped");
  }
};

/**
 * The recent failures this conversation's reader may hear about, for its
 * next human turn: when, where, what was asked, and why it failed. Null when
 * there are none, or when the conversation is not an audience for any.
 *
 * AUDIENCE. The note rides into the conversation the turn is in, and the
 * model may repeat it there, so it lists only failures the people in it may
 * already know about:
 *  - the conversation's OWN failures (the person re-asking in the thread
 *    that failed them should hear the agent acknowledge the miss);
 *  - in a workspace OWNER's direct thread with the agent, also the agent's
 *    other channel failures, by where, when and why: the owner is the
 *    alert's audience, so an owner who answers the alert in that DM ("what
 *    happened in #ops?") gets an agent that knows. Never their words: the
 *    owner already has them in the alert, and someone else's text has no
 *    place in the one conversation where the agent acts with the owner's
 *    own read access.
 * Never a shared channel's or another person's thread: one conversation's
 * failures must not reach a different audience.
 *
 * Self-clearing: a failure stops being listed once a LATER turn in the same
 * conversation finished `done` (the thread got its answer), and in any case
 * after the window.
 */
export const buildFailedRepliesNote = async (
  agentId: string,
  conversationId: string,
  before: Date,
): Promise<string | null> => {
  const reader = await db.conversation.findFirst({
    where: { id: conversationId, agentId },
    select: {
      direct: true,
      userId: true,
      agent: { select: { workspaceId: true } },
    },
  });
  if (!reader) return null;
  const ownersThread =
    reader.direct && reader.userId !== null
      ? (await db.workspaceAccess.findFirst({
          where: {
            workspaceId: reader.agent.workspaceId,
            userId: reader.userId,
            role: "owner",
          },
          select: { id: true },
        })) !== null
      : false;

  const since = new Date(before.getTime() - FAILED_REPLIES_WINDOW_MS);
  const failed = await db.turn.findMany({
    where: {
      ...failedPersonTurn,
      createdAt: { gte: since, lt: before },
      conversation: { agentId, threadLink: { isNot: null } },
      ...(ownersThread ? {} : { conversationId }),
    },
    orderBy: { createdAt: "desc" },
    // Over-fetch: some are dropped below as answered since.
    take: FAILED_REPLIES_MAX * 3,
    select: {
      id: true,
      conversationId: true,
      message: true,
      error: true,
      createdAt: true,
      conversation: {
        select: {
          threadLink: {
            select: {
              kind: true,
              externalThreadId: true,
              agentChannel: {
                select: { integrationId: true, provider: true },
              },
            },
          },
        },
      },
    },
  });
  if (failed.length === 0) return null;

  const answeredSince = await db.turn.findMany({
    where: {
      conversationId: { in: [...new Set(failed.map((t) => t.conversationId))] },
      status: "done",
      createdAt: { gte: since, lt: before },
    },
    select: { conversationId: true, createdAt: true },
  });
  const lastDone = new Map<string, number>();
  for (const row of answeredSince) {
    const prev = lastDone.get(row.conversationId) ?? 0;
    lastDone.set(row.conversationId, Math.max(prev, row.createdAt.getTime()));
  }

  const open = failed
    .filter(
      (turn) =>
        (lastDone.get(turn.conversationId) ?? 0) < turn.createdAt.getTime(),
    )
    .slice(0, FAILED_REPLIES_MAX)
    .reverse();
  if (open.length === 0) return null;

  const eventErrors = await errorEventsOf(
    open.filter((turn) => !turn.error).map((turn) => turn.id),
  );
  const lines = await Promise.all(
    open.map(async (turn) => {
      const when = stampOf(turn.createdAt);
      const reason = failureReasonOf(
        turn.error ?? eventErrors.get(turn.id) ?? null,
      );
      if (turn.conversationId === conversationId) {
        return `- ${when}, here: "${quoteOf(turn.message)}" (failed: ${reason})`;
      }
      // Only an owner's thread lists other conversations, and only channel
      // ones (the filter above), so the link is always there.
      const link = turn.conversation.threadLink;
      const where = link
        ? await whereOf({
            agentId,
            integrationId: link.agentChannel.integrationId,
            provider: link.agentChannel.provider,
            kind: link.kind,
            externalThreadId: link.externalThreadId,
          })
        : "a channel";
      return `- ${when}, in ${where} (failed: ${reason})`;
    }),
  );
  const elsewhere = open.some((turn) => turn.conversationId !== conversationId);
  return [
    "[Replies of yours that failed recently. Each person saw an error and got no answer:]",
    ...lines,
    "If one was asked here, answer it now and say in one short line that your earlier reply failed; don't explain internals.",
    ...(elsewhere
      ? [
          "If you are asked about one from elsewhere, say where it failed and why. The person who asked there still needs an answer in that conversation.",
        ]
      : []),
    "Never mention this note.",
    "[End of failed replies]",
  ].join("\n");
};
