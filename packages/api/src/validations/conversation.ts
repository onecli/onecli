import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@onecli/agent-protocol";
import { CHANNEL_PROVIDER_IDS } from "../services/channels/types";

/**
 * Conversations and turns (plans/hosted-agents-v2.md step 4). Constants live
 * here and are imported by the services, so the union has exactly one
 * definition — the house pattern from `validations/agent.ts`.
 */

/**
 * Where a conversation comes from. `web` is a person in the dashboard; the
 * rest arrive with their own steps (channels §3.16, crons step 7, watches
 * step 10, agent-to-agent PR 5b). Channel ingestion stamps
 * `source: presence.provider`, so the provider ids ARE sources — composed
 * from the one provider list, a new provider cannot forget this union.
 * `agent` is a peer OneCLI agent: the conversation's `externalRef` is the
 * peer's agent id, one continuous thread per pair per side.
 */
export const CONVERSATION_SOURCES = [
  "web",
  ...CHANNEL_PROVIDER_IDS,
  "cron",
  "watch",
  "agent",
] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

/**
 * A PEER TASK's report (the PR after 5b): the turn `complete_task`
 * materializes into the person's conversation after this agent talked with
 * another agent on the person's behalf, or the platform's own close line
 * when the task ended without a report. The agent's OWN words for the person
 * (never the peer's), so it renders as the agent speaking under a caption
 * that says where it came from, and it goes through every automation door:
 * the continuity bridge relays it into the person's next message, the
 * channel mirror posts it once with its caption, due-work ranks it behind
 * user-visible work (harmless: it is born done).
 *
 * A TURN source only, like the greeting: no client may mint a "peer_task"
 * conversation, and the pair conversations the task runs on keep their
 * `agent` source.
 */
export const PEER_TASK_SOURCE = "peer_task";

/** The non-human sources: a turn born from an automation, not a person
 * typing. The continuity bridge (turn-service) branches on this constant, and
 * the channel mirror (`apps/channel-adapter/src/mirror.ts`) imports it for
 * the same test — one definition, so a future automation source is ONE edit
 * here and both surfaces follow. `peer_task` is turn-only (above); the other
 * two are conversation sources too (a cron/watch RUN has its own
 * conversation, a task's report lands in the person's). */
export const AUTOMATION_SOURCES = [
  "cron",
  "watch",
  PEER_TASK_SOURCE,
] as const satisfies readonly TurnSource[];
export type AutomationSource = (typeof AUTOMATION_SOURCES)[number];

/**
 * The platform's hello on a brand-new direct thread: an instruction posted
 * with no user, which the agent answers live so the person is greeted by
 * their agent rather than by a sign the web hung up beforehand.
 *
 * A TURN source only — deliberately NOT a conversation source (the
 * client-facing create schema enumerates `CONVERSATION_SOURCES`, so no client
 * may mint a "greeting" conversation) and deliberately NOT an automation
 * source. It is USER-VISIBLE, FOREGROUND work, and `AUTOMATION_SOURCES` means
 * the opposite everywhere it is read:
 *
 *   - `due-work` ranks automations BEHIND user-visible turns (up to
 *     `WAKE_PRIORITY_AGE_SECONDS`) — the first thing a new user ever sees
 *     must never queue behind the 9:00 cron cohort.
 *   - `buildContinuityBridge` relays automation deliveries into the next
 *     human turn as "[Context from your automated runs]" — the greeting is
 *     already in the thread the model can see; relaying it would narrate the
 *     hello back to the agent on the user's FIRST message.
 *   - `buildOpenPromiseNote` gives automation wakes the agent's own last
 *     reply, which a first-contact greeting has no use for.
 *
 * What the greeting DOES share with an automation is its render shape: no
 * user typed it, so it wears no user bubble and gets no "(from the web)"
 * attribution. That is `isPlatformAuthoredSource` below, which is what the
 * render paths test — never `AUTOMATION_SOURCES`.
 */
export const GREETING_SOURCE = "greeting";

/** Every source a TURN may carry: conversation sources plus the turn-only
 * ones (the greeting, a peer task's report). */
export type TurnSource =
  | ConversationSource
  | typeof GREETING_SOURCE
  | typeof PEER_TASK_SOURCE;

/**
 * Nobody typed this turn's message — the platform authored it (an automation
 * header, or the greeting instruction). The render surfaces branch on THIS,
 * not on `AUTOMATION_SOURCES`: the question they are asking is "does this get
 * a user bubble", which is about authorship, not about scheduling priority.
 */
export const isPlatformAuthoredSource = (source: string): boolean =>
  source === GREETING_SOURCE ||
  (AUTOMATION_SOURCES as readonly string[]).includes(source);

/** A turn's lifecycle. The first three are the ACTIVE set the partial unique
 * index fences — at most one of them per conversation. `joining`/`joined` are
 * the mid-run FOLLOW-UP arc: a message sent while a turn was active rides its
 * own row — born `joining` (steering into the live turn), settled `joined`
 * when the run consumed it, or promoted in place to `queued` when it did not. */
export const TURN_STATUSES = [
  "queued",
  "dispatched",
  "running",
  "done",
  "failed",
  "aborted",
  "joining",
  "joined",
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** Active = occupies the conversation. Mirrors the WHERE of
 * `turns_one_active_per_conversation`; changing one without the other is a bug.
 * `joining` is deliberately NOT here — a follow-up coexists with the active
 * turn it steers into; that is the whole feature. */
export const ACTIVE_TURN_STATUSES = [
  "queued",
  "dispatched",
  "running",
] as const satisfies readonly TurnStatus[];

/** Unsettled = the user is still owed an outcome: active, or a follow-up
 * still steering. This is the WEB POLL's predicate — a `joining` row can fail
 * with no transcript event (the same no-event gap the poll exists for), so
 * the poll must outlive the active turn while one is parked. Never used in
 * any index-adjacent query: ACTIVE_TURN_STATUSES keeps that meaning exact. */
export const UNSETTLED_TURN_STATUSES = [
  ...ACTIVE_TURN_STATUSES,
  "joining",
] as const satisfies readonly TurnStatus[];

/** How many follow-ups may sit unconsumed on one conversation. Approximate
 * under concurrency (two racing sends can both read 9), deliberately — this
 * bounds runaway queues, not exact fairness. */
export const MAX_JOINING_FOLLOW_UPS = 10;

/** The cap refusal — shown inline on the web, posted as a reply on Slack.
 * Must stay VISIBLE on every surface: an invisible cap refusal would be the
 * silent-drop bug this feature exists to kill. */
export const FOLLOW_UP_CAP_MESSAGE =
  "You've sent several messages I haven't gotten to yet. Give me a moment to catch up.";

/** The joining-backstop sweep's copy. Never the run-time-limit text: a parked
 * follow-up that aged out never ran at all. */
export const FOLLOW_UP_EXPIRED_MESSAGE =
  "The agent never got to this message. Send it again.";

/**
 * Machine-readable failure reasons, set beside the human `Turn.error` ONLY
 * when a reader has to do something more than print the sentence.
 *
 * `no_model_key` and `model_provider_error` offer a fix that is a link away
 * (connect a key / check the key). The lifecycle codes (`agent_restarted`,
 * `agent_start_failed`, `at_capacity`, `image_unavailable`) tell the web
 * these are platform hiccups, not agent output — rendered as a quiet notice,
 * never the red failure box — and none of that can be decided by
 * pattern-matching on prose.
 */
/** The lifecycle subset, exported on its own because the web derives its
 * "render as a quiet notice" set from it (turn-block.tsx imports this module
 * directly, like the composer's TURN_MESSAGE_MAX_LENGTH) — a new lifecycle
 * code then reaches the UI without a hand-synced copy. */
export const LIFECYCLE_TURN_ERROR_CODES = [
  "agent_restarted",
  "agent_start_failed",
  "at_capacity",
  "harness_busy",
  "harness_no_terminal",
  "image_unavailable",
  "transcript_rejected",
  "turn_stalled",
  "turn_time_limit",
] as const;

export const TURN_ERROR_CODES = [
  "no_model_key",
  "model_provider_error",
  "trial_credit_exhausted",
  ...LIFECYCLE_TURN_ERROR_CODES,
] as const;
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];

/**
 * Deliberately temporary in tone. A send can lose a race with a grant that
 * lands a second later, and the copy must not tell that user their agent is
 * broken.
 */
export const NO_MODEL_KEY_MESSAGE =
  "This agent doesn't have a model key yet, so there's nothing for it to answer with. Connect one and send your message again.";

/*
 * The lifecycle-failure copy. The doctrine (§3.13): never the words
 * "sandbox", "container" or "runner"; temporary in tone — these are moments,
 * not verdicts about the agent; and every sentence says what to DO next.
 * The control plane owns this copy exclusively: the supervisor and runner
 * send machine CODES (packages/agent-protocol/src/failure-codes.ts) plus a
 * raw error string that goes to the server log, never to a person.
 */

/** A harness death AFTER observable work existed — must stay visible, and
 * the copy asks the person to judge the partial work before re-sending
 * (side effects may exist; a blind "send it again" would invite doubles). */
export const AGENT_RESTARTED_MESSAGE =
  "The agent had to restart while working on this. Check what it finished, then send it again.";

/** A start that could not happen (second cold-boot death, generic start
 * failure past its patience window, or the supervisor's launch classification
 * after the one invisible retry was spent). */
export const AGENT_START_FAILED_MESSAGE =
  "The agent couldn't start. Try again in a few minutes.";

/** The ceiling's arm for a turn that never started at all — the limit copy
 * would be a lie about time the agent never used (same tone family as
 * FOLLOW_UP_EXPIRED_MESSAGE). */
export const AGENT_NEVER_STARTED_MESSAGE =
  "The agent never got to this message. Send it again.";

/** The ceiling's arm for a turn that DID run and used its whole budget.
 * Decided control-plane-side (like `no_model_key`, never on a wire). The
 * doctrine holds: temporary in tone, says what to DO next — nothing the
 * agent finished is lost, and background work it was supervising keeps
 * running, so the recovery is one message away. */
export const TURN_TIME_LIMIT_MESSAGE =
  "This turn reached its time limit and was wrapped up. Finished work is saved, and anything running in the background continues. Send a message to get a status update and keep going.";

/** The stall arm's copy: a RUNNING turn whose supervisor heartbeat went
 * silent past the stall window. From the platform's view the agent stopped
 * responding — the sandbox died, wedged, or lost its channel — which is not
 * the turn's fault, so the tone matches the other lifecycle moments: what
 * survived, and that one message resumes. Decided control-plane-side. */
export const TURN_STALLED_MESSAGE =
  "The agent stopped responding and the turn was ended. Finished work is saved. Send a message to try again.";

/** Steered into a live run when it approaches the ceiling (due-work's
 * warning arm) — agent-facing, so it says exactly what to do with the time
 * left: stop waiting, report supervised work's status, and hand off. The
 * wording assumes nothing about WHAT is being supervised on purpose. */
export const TURN_CEILING_WARNING_MESSAGE =
  "[system] This turn is approaching its time limit and will be ended soon. Stop starting new work and stop waiting on long-running things now. Reply with: what you completed, the current status of anything still running (background processes, CI, other agents — they keep running after this turn ends), what remains, and how to continue in the next message. Then end the turn.";

/** The host has no room right now; honest about the wait, silent about the
 * infrastructure. */
export const AT_CAPACITY_MESSAGE =
  "The agent couldn't start because too many agents are running right now. Try again in a few minutes.";

/** The one operator-facing reason: retrying will not conjure the software.
 * Says who has to act without naming docker, images, or containers. */
export const IMAGE_UNAVAILABLE_MESSAGE =
  "The agent couldn't start because its software isn't installed where it runs yet. Ask whoever operates this install to finish the agent setup.";

/** The model provider refused the request — a usage limit, exhausted
 * credits, or a key that stopped working. The fix is the key, so the copy
 * points there (the web attaches the models-page link off the code, like
 * `no_model_key`). Raw provider responses never render on a chat surface:
 * this canonical copy replaces them; the raw text stays operator material
 * (the server log and the stored transcript events). */
export const MODEL_PROVIDER_ERROR_MESSAGE =
  "The agent's model provider rejected the request. This is usually a usage limit or an expired key. Check the connected model key, or connect a different one, then send your message again.";

/** The platform's free trial credit ran out mid-conversation — the agent was
 * running on OneCLI's own key (no key of the user's connected), and the
 * gateway paused it at the cap. The fix is the same family as
 * `no_model_key`: connect a key, one link away — so the copy points there
 * and the surfaces reuse the add-key door. Raw gateway 403 bodies never
 * render on a chat surface; this canonical copy replaces them (the raw text
 * stays operator material, like `model_provider_error`). */
export const TRIAL_CREDIT_EXHAUSTED_MESSAGE =
  "This agent was running on OneCLI's free trial credit, which is now used up. Connect your own model key, then send your message again.";

/** The harness refused the message because its session was still executing
 * earlier, platform-abandoned work and the adapter's self-heal (cancel +
 * resend with backoff) could not free it. Genuinely temporary: the blocked
 * run either finishes or dies, so a resend is the honest recovery. */
export const HARNESS_BUSY_MESSAGE =
  "The agent was still busy with earlier work and couldn't take this message. Send it again in a moment.";

/** The harness took the message and then never delivered a closing frame
 * within the adapter's deadline (issue #1124). The work the agent did is
 * saved in its session either way, so the tone is the lifecycle family's:
 * what survived, and that one message resumes. */
export const HARNESS_NO_TERMINAL_MESSAGE =
  "The agent went quiet before finishing this turn, so it was ended. Finished work is saved. Send a message to keep going.";

/** The model provider rejected the conversation itself as malformed. Its
 * stored history is replayed whole on every turn, so resending as-is fails
 * the same way. The known cause (#1194: a stop interrupted the agent mid
 * save and left its history duplicated) is repaired the next time the agent
 * starts, which an idle stop brings about on its own; any other cause needs
 * whoever operates the agent. The copy promises neither outcome: it says
 * the problem is the conversation's saved history, not the person's
 * message, and what to try. */
export const TRANSCRIPT_REJECTED_MESSAGE =
  "The agent couldn't continue because this conversation's saved history is damaged. It tries to repair it the next time it restarts, so send your message again in a little while. If this keeps happening, contact whoever operates this agent.";

/** The Slack mirror's last-resort line for a FAILED turn that produced no
 * answer text and no error anywhere — silence would read as the agent
 * ignoring the person (the seen-reaction is already stripped by the time the
 * mirror decides). Same doctrine as the family above. */
export const TURN_FAILED_SILENT_MESSAGE =
  "Something went wrong and this message didn't get an answer. Send it again.";

/** The Slack mirror's marker under a FAILED turn's partial answer — the text
 * above it is real but incomplete, and must not read as a normal reply. */
export const TURN_FAILED_PARTIAL_MESSAGE =
  "The agent stopped partway through this answer. Send it again.";

/** The Slack mirror's closure line for an aborted turn with nothing to show —
 * the web's word for the same moment (turn-block's aborted arm), kept
 * byte-identical by convention. */
export const TURN_STOPPED_MESSAGE = "Stopped.";

/**
 * The server-side allowlist: a WIRE failure code (supervisor/runner-supplied,
 * an open string there) → the canonical {code, message} pair written to the
 * turn. A code this map does not know degrades to the raw-error passthrough —
 * which is also exactly what an old peer that sends no code gets. Keyed by
 * `string` on purpose; `Partial` keeps every read a `| undefined`.
 *
 * `no_model_key` is deliberately absent: it never arrives on this wire (it is
 * decided control-plane-side, before any sandbox exists).
 */
export const TURN_FAILURE_COPY: Partial<
  Record<string, { code: TurnErrorCode; message: string }>
> = {
  agent_restarted: {
    code: "agent_restarted",
    message: AGENT_RESTARTED_MESSAGE,
  },
  agent_start_failed: {
    code: "agent_start_failed",
    message: AGENT_START_FAILED_MESSAGE,
  },
  model_provider_error: {
    code: "model_provider_error",
    message: MODEL_PROVIDER_ERROR_MESSAGE,
  },
  trial_credit_exhausted: {
    code: "trial_credit_exhausted",
    message: TRIAL_CREDIT_EXHAUSTED_MESSAGE,
  },
  harness_busy: {
    code: "harness_busy",
    message: HARNESS_BUSY_MESSAGE,
  },
  harness_no_terminal: {
    code: "harness_no_terminal",
    message: HARNESS_NO_TERMINAL_MESSAGE,
  },
  transcript_rejected: {
    code: "transcript_rejected",
    message: TRANSCRIPT_REJECTED_MESSAGE,
  },
};

/** Generous but bounded — a turn's message crosses two hops and is stored. */
export const TURN_MESSAGE_MAX_LENGTH = 100_000;

/**
 * U+0000. Built rather than written as an escape, because the byte itself
 * must never appear in this source file.
 */
const NUL = String.fromCharCode(0);

/**
 * JSON permits U+0000; PostgreSQL accepts it in neither `text` nor `jsonb`.
 * Without this the database raises and the request becomes a 500 — a server
 * error for what is unambiguously bad input.
 *
 * Rejected here rather than stripped, because this is what a person typed:
 * quietly altering their message would be worse than telling them. Model
 * output is the opposite case and is sanitized instead — see `turn-service`.
 */
const noNulBytes = <T extends z.ZodType<string>>(schema: T) =>
  schema.refine((value) => !value.includes(NUL), {
    message: "must not contain a null byte",
  });

export const createConversationSchema = z.object({
  agentId: z.string().min(1),
  source: z.enum(CONVERSATION_SOURCES).optional(),
  externalRef: noNulBytes(z.string().trim().min(1).max(500)).optional(),
  title: noNulBytes(z.string().trim().min(1).max(200)).optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const createTurnSchema = z
  .object({
    // `min(1)` moved into the refine below: a message may be EMPTY when the
    // send carries attachments (a file with no words is a normal message).
    message: noNulBytes(z.string().max(TURN_MESSAGE_MAX_LENGTH)),
    /** Previously-uploaded `pending` attachments to bind to this turn.
     * Validated for real (ownership, status, conversation) inside the
     * turn-create transaction — this is just the shape gate. */
    attachmentIds: z
      .array(z.string().uuid())
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .optional(),
  })
  .refine(
    (body) => body.message.length > 0 || (body.attachmentIds?.length ?? 0) > 0,
    { message: "message or attachments required" },
  );
export type CreateTurnInput = z.infer<typeof createTurnSchema>;

/**
 * A transcript cursor: the highest `seq` the caller has, not an offset.
 * Defined once because it arrives two ways — `?since=` on the query string and
 * `Last-Event-ID` on an SSE reconnect — and both must validate identically.
 */
export const cursorSchema = z.coerce
  .number()
  .int()
  .min(0)
  // Bounded ABOVE too: `TurnEvent.seq` is a 32-bit INTEGER, and a larger
  // cursor does not come back as "no rows" — Prisma raises a conversion
  // error, which is not a ServiceError, so the transcript endpoint answers
  // 500 for plainly bad input and the stream answers 200-then-close, which
  // an SSE client retries forever.
  .max(2_147_483_647);

export const transcriptQuerySchema = z.object({
  since: cursorSchema.optional(),
  /** Inclusive upper bound, for reading an OLDER window's events without
   * re-walking territory the caller already holds (`since < seq <= until`).
   * Same 32-bit bound discipline as `since`. */
  until: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;

/**
 * How many turns one window of `GET /turns` returns when the caller doesn't
 * say. 50 is the industry's chat-history default (Discord's page size; Slack
 * recommends staying under 200) — and a turn here is a whole exchange, so 50
 * turns is well over 100 rendered messages.
 */
export const TURNS_PAGE_DEFAULT = 50;

/** The window cap — the pre-pagination `take: 200` kept as the ceiling. */
export const TURNS_PAGE_MAX = 200;

/**
 * `GET /conversations/:id/turns` — a NEWEST-FIRST window. `before` is a turn
 * id cursor (keyset, never an offset: stable while new turns land behind it,
 * O(page) however deep the history). Plain `.uuid()` like `attachmentIds`.
 */
export const turnsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(TURNS_PAGE_MAX).optional(),
  before: z.string().uuid().optional(),
});
export type TurnsQuery = z.infer<typeof turnsQuerySchema>;
