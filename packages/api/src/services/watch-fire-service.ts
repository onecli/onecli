import { db } from "@onecli/db";
import { canAccessWorkspaceAsUser } from "./workspace-access-check";
import {
  claimTriggeredWatches,
  claimTriggeredWatchesForOrigins,
  sweepExpiredWatches,
  sweepLostProcesses,
  sweepWatchCoherence,
  type DueWatchFire,
} from "./due-work";
import { ensureSourcedConversation } from "./conversation-service";
import {
  createFollowUp,
  createTurn,
  materializeAutomationDelivery,
} from "./turn-service";
import { ServiceError } from "./errors";
import { stripControl } from "../lib/text";
import { logger } from "../lib/logger";

const log = logger.child({ component: "watch-fire" });

/**
 * Firing background-process watches (step 10) — the cron-fire template, with
 * two deliberate differences: watches are ONE-SHOT (no schedule to advance,
 * no consecutive-failure disable), and a watch fires from a control-plane
 * poll after the SWEEPS convert triggered/lost/expired states. Driven from
 * the runner work poll (§3.3), best-effort per watch — one broken watch must
 * never block the others or the poll.
 *
 * The CLAIM lives in due-work (the dispatch seam owns dueness); this module
 * owns what a fire IS. Two destinations, decided per watch:
 *
 * - IN-ORIGIN (the product behavior): a watch whose origin is a DIRECT
 *   conversation the fence admits fires INSIDE that conversation — one
 *   consolidated turn per origin per pass, resuming the thread's own harness
 *   session, so the wake's report is the turn itself, streamed live where
 *   the person is. A busy origin RETRIES on the fire lease (today's silent
 *   mark-fired drop is gone) until the watch's own expiry downgrades it.
 * - HIDDEN (the fallback, and everything else): the watch's own sourced
 *   conversation, exactly as before — a fresh run whose report is delivered
 *   to the origin by the settle chain.
 */

const cleanName = (raw: string): string =>
  stripControl(raw).replace(/\n/g, " ").trim().slice(0, 100);

/** The trigger, said in plain words for the fired turn's header. */
const triggerSentence = (watch: DueWatchFire): string => {
  switch (watch.trigger) {
    case "exited":
      return watch.exitCode === null
        ? "the process finished"
        : `the process exited with code ${watch.exitCode}`;
    case "matched":
      return "its output matched what you were watching for";
    case "silent":
      return "the process went quiet";
    case "lost":
      return "the process was lost when the machine restarted — it is no longer running";
    default:
      return "the watched condition occurred";
  }
};

export const buildWatchRunMessage = (watch: DueWatchFire): string => {
  const label = cleanName(watch.processName ?? watch.processCommand);
  // The delivery promise is only made when there IS a chat to deliver to: a
  // watch with no origin (its arm carried no verifiable context) runs and
  // settles with its transcript as the only record — promising delivery
  // there would be a lie the model acts on.
  const destination = watch.originConversationId
    ? "it reaches the chat this watch belongs to"
    : "it is kept as this run's record";
  const header = `[Watch on process "${label}" fired: ${triggerSentence(watch)} — triggered automatically, not by a person typing. Do the task below and finish with a SHORT report — outcome first, then only what changed or needs attention, a few lines at most; ${destination}.]`;
  const excerpt = watch.excerpt
    ? `\n\n[Recent output:]\n${stripControl(watch.excerpt)}`
    : "";
  return `${header}\n\n${watch.prompt}${excerpt}`;
};

/**
 * The consolidated in-origin shape: one platform header, then per-watch
 * blocks — with byte-identical prompts stated ONCE for their whole group
 * (the safety-net and implicit-wake prompts repeat verbatim across a
 * batch, and repeating them N times only burns the model's attention).
 * Whole-block budget keeps the message far under the wire's 100k cap.
 */
export const CONSOLIDATED_MESSAGE_BUDGET = 32_000;

export const buildConsolidatedWakeMessage = (
  watches: DueWatchFire[],
): string => {
  if (watches.length === 1) {
    const only = watches[0];
    if (only) return buildWatchRunMessage(only);
  }
  const header = `[Platform wake: ${watches.length} background task(s) you were watching finished — triggered automatically, not by a person typing. This runs in the chat the work belongs to. Do what each item below asks and give one SHORT combined report directly in this reply — the outcome per item in a line each, plus anything needing attention.]`;

  // Group by identical prompt text, preserving first-seen order.
  const groups = new Map<string, DueWatchFire[]>();
  for (const watch of watches) {
    const group = groups.get(watch.prompt);
    if (group) group.push(watch);
    else groups.set(watch.prompt, [watch]);
  }

  const parts: string[] = [header];
  let used = header.length;
  let dropped = 0;
  for (const [prompt, group] of groups) {
    const lines = group.map((watch) => {
      const label = cleanName(watch.processName ?? watch.processCommand);
      const excerpt = watch.excerpt
        ? `\n[Recent output:]\n${stripControl(watch.excerpt)}`
        : "";
      return `- "${label}": ${triggerSentence(watch)}.${excerpt}`;
    });
    const block = `${prompt}\n\n${lines.join("\n")}`;
    if (used + block.length > CONSOLIDATED_MESSAGE_BUDGET) {
      dropped += group.length;
      continue;
    }
    used += block.length;
    parts.push(block);
  }
  if (dropped > 0) {
    // Never silent: the model is told the batch was clipped, and
    // process_status still shows everything.
    parts.push(
      `[${dropped} more finished task(s) did not fit this message — check process_status for the rest.]`,
    );
  }
  return parts.join("\n\n");
};

/**
 * Fire-time authorization, exactly as crons: the SUBJECT (the watch's
 * creator, or — for platform-armed watches with no verified creator — the
 * direct thread's owner) must still hold workspace access. A subject who
 * lost access cannot keep a foothold through a watch armed earlier.
 */
const subjectMayFire = async (
  subjectUserId: string,
  workspaceId: string,
): Promise<boolean> => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, organizationId: true },
  });
  return workspace ? canAccessWorkspaceAsUser(subjectUserId, workspace) : false;
};

const cancelWatch = async (watchId: string, reason: string): Promise<void> => {
  await db.processWatch.updateMany({
    where: { id: watchId, status: "triggered" },
    data: { status: "canceled" },
  });
  log.warn({ watchId, reason }, "watch canceled at fire time");
};

const fireOne = async (watch: DueWatchFire): Promise<void> => {
  // A one-shot watch has nothing to disable — an unauthorized one is simply
  // canceled. Creatorless watches pass here (they carry no user authority
  // and their hidden run conversation grants none).
  if (watch.createdByUserId) {
    const allowed = await subjectMayFire(
      watch.createdByUserId,
      watch.workspaceId,
    );
    if (!allowed) {
      await cancelWatch(watch.id, "creator lost workspace access");
      return;
    }
  }

  // One persistent conversation per watch: externalRef = the watch id, so the
  // (agentId, source, externalRef) unique makes this race-safe.
  const conversation = await ensureSourcedConversation(
    watch.workspaceId,
    watch.agentId,
    {
      source: "watch",
      externalRef: watch.id,
      title: watch.processName ?? "Process watch",
    },
  );

  // Mark fired REGARDLESS of the turn's outcome — a watch is one-shot, so this
  // is the terminal step whether the run starts, is refused, or conflicts.
  const markFired = () =>
    db.processWatch.updateMany({
      where: { id: watch.id, status: "triggered" },
      data: { status: "fired", firedAt: new Date() },
    });

  try {
    const turn = await createTurn(
      watch.workspaceId,
      conversation.id,
      buildWatchRunMessage(watch),
      { source: "watch", userId: null },
    );
    await markFired();
    // Door 1 (no model key): the turn is born failed and never reaches
    // finishTurn, so — unlike a cron, which retries next occurrence — the
    // "wake me" would vanish silently. Deliver the failure to the origin so
    // the person learns the watch fired but could not run.
    if (turn.status === "failed" && watch.originConversationId) {
      await materializeAutomationDelivery(
        watch.originConversationId,
        `Watch on "${cleanName(watch.processName ?? watch.processCommand)}"`,
        `The watch fired, but the run could not start: ${turn.error ?? "no model key."}`,
        "watch",
      );
    }
  } catch (error) {
    if (error instanceof ServiceError && error.code === "CONFLICT") {
      // The watch's own conversation already has a turn running (a prior fire
      // still going). One-shot: mark fired and move on — no retry.
      await markFired();
      log.info({ watchId: watch.id }, "watch conversation busy; fired anyway");
      return;
    }
    throw error;
  }
};

/** The in-origin bucket for one direct conversation, fence already passed. */
interface WakeBucket {
  conversationId: string;
  agentId: string;
  workspaceId: string;
  /** The access subject per watch: its creator, or the thread owner. */
  watches: { watch: DueWatchFire; subjectUserId: string }[];
}

/**
 * Fire one origin's bucket as ONE consolidated turn INSIDE the origin
 * conversation. Outcome table (the order of `markFired` is the contract):
 * - created (running or born-failed) → every watch marked fired in one
 *   guarded batch. A born-failed turn (door 1) is ITSELF visible in the
 *   thread, so no delivery duplicate is materialized.
 * - CONFLICT (the thread's one-active slot is taken) → JOIN first: the wake
 *   steers into the running turn as a follow-up, and the watches are marked
 *   fired only once that row exists. When there is no running turn to join,
 *   or the join fails, the older behavior stands — nothing marked, unexpired
 *   watches stay claimed and retry on the fire lease (the path before that
 *   marked them fired and silently dropped the wake), and expired ones
 *   downgrade to the hidden path so a forever-busy thread cannot retry past
 *   the watch's own deadline.
 * - anything else → nothing marked; the lease retries.
 */
/**
 * Steer a busy conversation's wake INTO the turn that is already running,
 * rather than queueing behind it.
 *
 * Returns whether the join landed. `false` means the caller keeps today's
 * behavior exactly — unexpired watches stay claimed and retry, expired ones
 * downgrade to the hidden path — so this can only ever REDUCE doubled wakes,
 * never lose one.
 *
 * ORDERING IS THE CONTRACT. The watches are marked fired only once the join
 * row exists: a crash between the two would otherwise leave them claimed and
 * deliver the same wake twice. That is the same rule the created-turn arm
 * above follows, for the same reason.
 *
 * Not a guarantee of one message: steering is at-most-once and the harness
 * takes it at its next safe point. A steer that misses still surfaces —
 * `listConversationsWithParkedFollowUps` promotes the parked row into its
 * own turn, which is today's behavior.
 */
const joinRunningTurn = async (
  bucket: WakeBucket,
  message: string,
  ids: string[],
): Promise<boolean> => {
  try {
    const running = await db.turn.findFirst({
      where: { conversationId: bucket.conversationId, status: "running" },
      select: { id: true },
    });
    // The conflict was something other than a live turn (a queued one, a
    // race that resolved). Nothing to steer into.
    if (!running) return false;

    await createFollowUp(bucket.conversationId, running.id, message, {
      source: "watch",
      userId: null,
    });
    // Only now: the row exists, so the wake cannot be delivered twice.
    await db.processWatch.updateMany({
      where: { id: { in: ids }, status: "triggered" },
      data: { status: "fired", firedAt: new Date() },
    });
    log.info(
      {
        conversationId: bucket.conversationId,
        turnId: running.id,
        joined: ids.length,
      },
      "origin busy; wake joined the running turn",
    );
    return true;
  } catch (err) {
    // Best-effort by design: anything unexpected falls back to the retry and
    // downgrade path, which is what shipped before this existed.
    log.info(
      { err: String(err), conversationId: bucket.conversationId },
      "wake join failed; falling back to retry",
    );
    return false;
  }
};

const fireBucket = async (bucket: WakeBucket): Promise<void> => {
  const message = buildConsolidatedWakeMessage(
    bucket.watches.map((entry) => entry.watch),
  );
  const ids = bucket.watches.map((entry) => entry.watch.id);
  try {
    await createTurn(bucket.workspaceId, bucket.conversationId, message, {
      source: "watch",
      userId: null,
      directWake: { agentId: bucket.agentId },
    });
    await db.processWatch.updateMany({
      where: { id: { in: ids }, status: "triggered" },
      data: { status: "fired", firedAt: new Date() },
    });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "CONFLICT") {
      // The thread's one active slot is taken — the agent is mid-answer,
      // very often about the FIRST watch of this same batch. Waiting is what
      // produced the running commentary: agent A finishes, the wake fires,
      // agent B finishes 10s later, and its wake queues behind a turn that
      // is already talking about A.
      //
      // JOIN it instead. `createFollowUp` is built for exactly this — a
      // `joining` row that steers into the running turn — so the batch is
      // reported once, by the turn already speaking.
      if (await joinRunningTurn(bucket, message, ids)) return;

      const now = Date.now();
      const expired = bucket.watches.filter(
        (entry) => entry.watch.expiresAt.getTime() < now,
      );
      log.info(
        {
          conversationId: bucket.conversationId,
          waiting: ids.length - expired.length,
          downgraded: expired.length,
        },
        "origin busy; unexpired watches stay claimed for retry",
      );
      for (const entry of expired) {
        await fireOne(entry.watch).catch((err) =>
          log.error(
            { err, watchId: entry.watch.id },
            "hidden-path downgrade failed",
          ),
        );
      }
      return;
    }
    throw error;
  }
};

/**
 * Partition the claimed watches: direct-origin watches whose fence passes
 * group into per-conversation buckets (one consolidated in-origin turn
 * each); no-origin, non-direct-origin, and creator/owner-mismatch watches
 * take the hidden path unchanged. An UNAUTHORIZED subject is neither — the
 * watch is CANCELED outright (hidden-firing it would still deliver into
 * the departed subject's thread via the settle chain).
 */
const partitionDue = async (
  due: DueWatchFire[],
): Promise<{ buckets: WakeBucket[]; singles: DueWatchFire[] }> => {
  const singles: DueWatchFire[] = [];
  const withOrigin = due.filter((watch) => watch.originConversationId);
  const originIds = [
    ...new Set(withOrigin.map((watch) => watch.originConversationId as string)),
  ];
  const conversations =
    originIds.length > 0
      ? await db.conversation.findMany({
          where: { id: { in: originIds } },
          select: { id: true, agentId: true, direct: true, userId: true },
        })
      : [];
  const byId = new Map(conversations.map((row) => [row.id, row]));

  const buckets = new Map<string, WakeBucket>();
  const subjectVerdicts = new Map<string, boolean>();
  for (const watch of due) {
    const origin = watch.originConversationId
      ? byId.get(watch.originConversationId)
      : undefined;
    // The fence: direct thread, same agent, and the creator — when one is
    // recorded — must BE the thread owner. Platform-armed watches carry no
    // creator (their context had no verified turn); for those the thread
    // owner becomes the access subject, so "no foothold after access loss"
    // transfers to the person whose DM the report lands in.
    const ownerSubject =
      origin &&
      origin.direct &&
      origin.agentId === watch.agentId &&
      origin.userId &&
      (watch.createdByUserId === null ||
        watch.createdByUserId === origin.userId)
        ? origin.userId
        : null;
    if (!origin || !ownerSubject) {
      singles.push(watch);
      continue;
    }
    // Access is per (subject, workspace) — one pass can span workspaces,
    // so the memo key must carry both or a verdict would leak across.
    const verdictKey = `${ownerSubject}:${watch.workspaceId}`;
    let allowed = subjectVerdicts.get(verdictKey);
    if (allowed === undefined) {
      allowed = await subjectMayFire(ownerSubject, watch.workspaceId);
      subjectVerdicts.set(verdictKey, allowed);
    }
    if (!allowed) {
      await cancelWatch(watch.id, "wake subject lost workspace access");
      continue;
    }
    const bucket = buckets.get(origin.id) ?? {
      conversationId: origin.id,
      agentId: watch.agentId,
      workspaceId: watch.workspaceId,
      watches: [],
    };
    bucket.watches.push({ watch, subjectUserId: ownerSubject });
    buckets.set(origin.id, bucket);
  }
  return { buckets: [...buckets.values()], singles };
};

/**
 * Fire everything due. The sweep ORDER matters: lost → coherence → expiry →
 * claim, so this poll's claim already sees the conversions, and expiry runs
 * AFTER coherence so a watch that triggered in time still fires even if its
 * deadline has since passed. After partitioning, the origins about to fire
 * absorb their STRAGGLERS (watches the LIMIT-bounded claim split into the
 * next pass) so one wake turn carries the whole batch.
 */
export const fireDueWatches = async (): Promise<number> => {
  await sweepLostProcesses();
  await sweepWatchCoherence();
  await sweepExpiredWatches();
  const due = await claimTriggeredWatches();
  const { buckets, singles } = await partitionDue(due);

  if (buckets.length > 0) {
    const stragglers = await claimTriggeredWatchesForOrigins(
      buckets.map((bucket) => bucket.conversationId),
    ).catch((err) => {
      log.warn({ err }, "straggler claim failed; firing the first batch");
      return [] as DueWatchFire[];
    });
    if (stragglers.length > 0) {
      const claimedIds = new Set(due.map((watch) => watch.id));
      const fresh = stragglers.filter((watch) => !claimedIds.has(watch.id));
      const byConversation = new Map(
        buckets.map((bucket) => [bucket.conversationId, bucket]),
      );
      for (const watch of fresh) {
        const bucket = watch.originConversationId
          ? byConversation.get(watch.originConversationId)
          : undefined;
        // Same origin ⇒ same fence verdict as the bucket's members, except
        // the creator check, which is per-watch.
        const owner = bucket?.watches[0]?.subjectUserId;
        if (
          bucket &&
          owner &&
          (watch.createdByUserId === null || watch.createdByUserId === owner)
        ) {
          bucket.watches.push({ watch, subjectUserId: owner });
        } else {
          singles.push(watch);
        }
      }
    }
  }

  for (const bucket of buckets) {
    try {
      await fireBucket(bucket);
    } catch (err) {
      log.error(
        { err, conversationId: bucket.conversationId },
        "wake bucket fire failed",
      );
    }
  }
  for (const watch of singles) {
    try {
      await fireOne(watch);
    } catch (err) {
      log.error({ err, watchId: watch.id }, "watch fire failed");
    }
  }
  return due.length;
};
