import {
  isInlineableImage,
  isTerminalEvent,
  INLINE_IMAGES_TOTAL_MAX_BYTES,
  MAX_TURN_RESULT_ERROR_CHARS,
  MAX_UNHEALTHY_REASON_CHARS,
  TURN_FAILURE_CODES,
  type AttachmentManifestEntry,
  type Harness,
  type HarnessSession,
  type SupervisorTransport,
  type TurnImage,
  type TurnUsage,
  type WorkItem,
} from "@onecli/agent-protocol";
import type { SupervisorConfig } from "./config";
import { log } from "./log";
import { isProviderRefusal, isTrialCreditExhausted } from "./provider-refusal";
import { renderHome, type RenderInputs } from "./home/renderer";
import { applyHomeSync } from "./home/materializer";
import {
  createAttachmentAssembler,
  pruneStaleAttachments,
  readMaterializedAttachment,
} from "./home/attachments";
import { startPlatformTools } from "./platform-tools";
import { attachmentsFragment } from "./capabilities/attachments";
import { connectionsFragment } from "./capabilities/connections";
import { cronsFragment, cronsTools } from "./capabilities/crons";
import { machineFragment } from "./capabilities/machine";
import { memoryFragment, memoryTools } from "./capabilities/memory";
import { skillsFragment } from "./capabilities/skills";
import {
  createProcessTools,
  processesFragment,
} from "./capabilities/processes";
import { createProcessManager, type ProcessManager } from "./processes/manager";
import { createProcessObserver } from "./processes/observer";
import {
  createMemoryHarvester,
  type MemoryHarvester,
} from "./home/memory-harvest";

/**
 * The supervisor loop.
 *
 * Its shape is dictated by two requirements that a single `for await` over the
 * transport cannot satisfy together:
 *
 * 1. **One harness session per conversation** (§3.6). An agent has one
 *    computer but many conversations, and their contexts must not bleed — so
 *    a turn runs in its conversation's own session, resumed by ref.
 * 2. **Abort must land while a turn is running.** Awaiting a turn inside the
 *    read loop means an abort frame sits unread until the turn it was meant to
 *    cancel has already finished — which is to say, never works.
 *
 * So the reader never awaits a turn: it dispatches onto a per-conversation
 * queue and goes straight back to reading. Turns of DIFFERENT conversations
 * therefore run concurrently, which is what the harness's ~10 MB-per-session
 * cost was measured for; turns of the SAME conversation stay serialized,
 * mirroring the control plane's one-active-turn law.
 */

/**
 * Memory guard on a single turn's accumulated answer. Not a product limit —
 * the wire applies the visible one — just the point past which a runaway
 * model stops being allowed to grow this process's heap.
 */
export const MAX_ANSWER_CHARS = 256_000;

/**
 * Cadence of the turn-liveness heartbeat (`progress` frames). Comfortably
 * inside the control plane's stall window (TURN_STALL_SECONDS, default 600s)
 * so one dropped frame never reads as a wedge, and cheap enough to run
 * unconditionally for every in-flight turn. A constant, not an env knob —
 * the stall window is the tunable; the heartbeat just has to beat it.
 */
export const PROGRESS_INTERVAL_MS = 60_000;

/**
 * The signal path (index.ts) exits immediately without running the loop's
 * `finally`, so a running supervisor registers a synchronous cleanup here
 * that the handler can call before `process.exit` — today, SIGTERM'ing every
 * background process group so children get their flush chance. A plain
 * module-level hook avoids threading the manager up into index.ts.
 */
let signalCleanup: (() => void) | null = null;
export const registerSignalCleanup = (fn: () => void): void => {
  signalCleanup = fn;
};
export const runSignalCleanup = (): void => {
  try {
    signalCleanup?.();
  } catch {
    // best-effort: the container is about to die regardless
  }
};

/** A mid-run follow-up waiting to steer into its target turn. */
interface SteerInboxEntry {
  targetTurnId: string;
  /** The follow-up row's id — the outcome's correlation key. */
  id: string;
  message: string;
}

/**
 * Per-conversation ceiling on parked steer entries. The control plane caps
 * parked follow-ups well below this; the margin absorbs edge duplicates, and
 * anything dropped here is recovered by promotion (the message runs as the
 * next turn) — bounded memory beats a perfect inbox.
 */
const MAX_STEER_INBOX = 20;

/**
 * How many steer outcomes one turn may report — the `turn.result.followUps`
 * wire cap. The drain STOPS at this many deliveries: an outcome that cannot
 * ride the terminal report would leave its `joined` unrecorded, and the
 * control plane would then promote (re-run) a message the model already
 * consumed. Entries left parked past the cap promote instead — duplicate
 * work avoided, message still never lost.
 */
const MAX_REPORTED_STEERS = 16;

interface ConversationRuntime {
  session?: HarnessSession;
  /** Tail of the per-conversation chain; every turn awaits the previous. */
  queue: Promise<void>;
  /** The turn currently executing, so an abort knows what to stop. */
  activeTurnId?: string;
  /**
   * Set once the active turn has entered its harness stream — the point past
   * which `session.abort()` has a run to cancel. BEFORE it, there is nothing
   * to cancel (aborting an idle session is a no-op), so an abort must PARK
   * (pendingAborts) rather than fire live. The pre-stream window is not just
   * session startup: a turn now also awaits the home-sync chain (the
   * boot-seed guarantee), which can span harvest round-trips — so this flag,
   * not `session` presence, is what tells `abort()` whether the stream is
   * live. Reset per turn.
   */
  streamStarted?: boolean;
  /** Set when an abort was actually delivered to the running session. */
  abortedTurnId?: string;
  /**
   * Aborts that arrived before their turn could act on them — during session
   * startup OR the pre-stream sync-await. The control plane clears its abort
   * flag when it hands the request over, so an abort dropped here is gone for
   * good and the turn would run to completion against the user's explicit
   * instruction.
   */
  pendingAborts: Set<string>;
  /**
   * Follow-ups awaiting delivery into their target's live run. Entries whose
   * target never becomes the active turn are pruned when another turn starts
   * (the conversation serializes turns, so any other target is terminal by
   * then) — the control plane's promotion path owns their recovery.
   */
  steerInbox: SteerInboxEntry[];
  /**
   * Steers DELIVERED to the active turn's session: id → "the adapter
   * confirmed the run consumed it". Reported on `turn.result` as
   * joined/missed; the adapter's in-flight gate is the delivery arbiter.
   */
  steered: Map<string, boolean>;
  /**
   * Serializes steer drains. Two callers can otherwise overlap — the reader
   * loop's inline arm and the turn's first-event drain — and an entry picked
   * by both before either removes it would inject the user's words TWICE.
   */
  steerDrain: Promise<void>;
}

export const runSupervisor = async (
  config: SupervisorConfig,
  harness: Harness,
  transport: SupervisorTransport,
  deps?: {
    applySync?: typeof applyHomeSync;
    processManager?: ProcessManager;
    memoryHarvester?: MemoryHarvester;
  },
): Promise<void> => {
  const applySync = deps?.applySync ?? applyHomeSync;
  // MUTABLE on purpose (step 9): a home sync's final part carries fresh
  // instructions/agentName and re-renders from this same holder — a dashboard
  // brief edit reaches the docs mid-run.
  const renderInputs: RenderInputs = {
    instructions: config.instructions,
    agentName: config.agentName,
    capabilities: harness.capabilities,
    // The §3.7 registry: each enabled capability contributes its fragment
    // here and its tools below — they arrive together, disappear together.
    // Connections leads and is unconditional: the gateway is a platform
    // property, not a harness capability, and gateway-first is the rule the
    // agent must hold before its first external call — only its skill-path
    // bullet depends on the adapter. Skills and connections are fragment-only
    // (no tools); skills is present only when the adapter declares a skills
    // directory.
    fragments: [
      connectionsFragment(harness.capabilities.skillsDir),
      cronsFragment,
      memoryFragment,
      processesFragment,
      // Unconditional like connections: what survives sleep/relaunch is a
      // substrate property. Registered AFTER processes — its last bullet
      // says "see Background processes above".
      machineFragment,
      // Unconditional like connections: receiving files is a platform
      // property (every harness can read a file), not an adapter capability.
      attachmentsFragment,
      ...(harness.capabilities.skillsDir
        ? [skillsFragment(harness.capabilities.skillsDir)]
        : []),
    ],
  };
  const rendered = renderHome(config.homeDir, renderInputs);
  log("info", "home rendered", { files: rendered.files });

  // Attachment files from prior turns age out at boot (mtime-based, bounded
  // sweep) — the volume is durable and per-turn dirs would otherwise grow
  // forever.
  pruneStaleAttachments(config.homeDir);
  const attachmentAssembler = createAttachmentAssembler(config.homeDir);

  /**
   * Re-read a turn's image attachments off the disk for inline vision,
   * packed ascending by size within the per-turn budget (jcode's harness
   * socket refuses frames past 16MiB, and images ride the message's own
   * frame). Ascending means the FIRST over-budget candidate ends the pack —
   * everything after it is bigger. A file that fails its integrity re-read
   * (swapped, missing) is skipped; it stays the read tool's problem.
   */
  const collectInlineImages = (
    manifest: AttachmentManifestEntry[] | undefined,
  ): TurnImage[] => {
    if (!manifest || manifest.length === 0) return [];
    const candidates = manifest
      .filter((entry) => isInlineableImage(entry.mimeType, entry.sizeBytes))
      .sort((a, b) => a.sizeBytes - b.sizeBytes);
    const images: TurnImage[] = [];
    let spent = 0;
    for (const entry of candidates) {
      if (spent + entry.sizeBytes > INLINE_IMAGES_TOTAL_MAX_BYTES) break;
      const bytes = readMaterializedAttachment(
        config.homeDir,
        entry.path,
        entry,
      );
      if (!bytes) {
        log("warn", "inline image unavailable on disk; read tool only", {
          path: entry.path,
        });
        continue;
      }
      spent += entry.sizeBytes;
      images.push({
        mediaType: entry.mimeType,
        dataBase64: bytes.toString("base64"),
      });
    }
    return images;
  };

  // Background processes (step 10): the manager owns spawn/detection and
  // reports durable state upstream as process.state frames. Registered for
  // the signal path too — SIGTERM exits immediately, and the children
  // deserve their flush chance (a sync group-kill is legal in a handler).
  const processes =
    deps?.processManager ??
    createProcessManager({
      homeDir: config.homeDir,
      send: (message) => transport.send(message),
    });
  registerSignalCleanup(() => processes.killAllSync("SIGTERM"));

  const conversations = new Map<string, ConversationRuntime>();

  // The home-sync chain (step 9): its own serialized queue, separate
  // from every conversation queue — the reader NEVER awaits it, so aborts
  // stay live while files write.
  let syncQueue: Promise<void> = Promise.resolve();
  /** The generation whose apply threw — its remaining parts are skipped so no
   * ack is ever sent for an incomplete projection. */
  let poisonedSyncGeneration: number | null = null;

  // Attributes work to the calling turn only when that is unambiguous — one
  // active turn — because a wrong anchor is worse than none. Shared by the
  // platform-tool channel and the background-task observer (both anchor
  // arm-time context the same way).
  const activeTurn = (): { conversationId: string; turnId: string } | null => {
    let found: { conversationId: string; turnId: string } | null = null;
    for (const [conversationId, runtime] of conversations) {
      if (!runtime.activeTurnId) continue;
      if (found) return null; // two turns in flight — ambiguous
      found = { conversationId, turnId: runtime.activeTurnId };
    }
    return found;
  };

  // The platform-tool channel (step 7): the harness's MCP bridge dials the
  // local socket; invocations ride the transport as correlated tool.calls.
  // Started before the ready signal so the socket exists by the time the
  // harness spawns the bridge.
  const platformTools = await startPlatformTools({
    tools: [...cronsTools, ...memoryTools, ...createProcessTools(processes)],
    send: (message) => transport.send(message),
    activeTurn,
  });

  // The memory harvester (§3.8 write-back): watches `memory/` for
  // agent-authored bytes and uploads them — the platform stays the single
  // source of truth, the files are the working copy. Also the materializer's
  // pre-overwrite/pre-prune gate, which is why the sync chain gets it.
  const harvester =
    deps?.memoryHarvester ??
    createMemoryHarvester({
      homeDir: config.homeDir,
      send: (message) => transport.send(message),
      activeTurn,
    });

  // Step 10 addendum: a harness that runs background tasks of its OWN gets
  // them observed into the same process machinery — mirrored entries, the
  // same frames/rows/keep-awake/fire pipeline — because work the platform
  // cannot see dies silently at idle-stop (proven live).
  const observer = harness.backgroundTasks
    ? createProcessObserver({
        manager: processes,
        tasks: harness.backgroundTasks,
        activeTurn,
      })
    : null;

  const runtimeFor = (conversationId: string): ConversationRuntime => {
    const existing = conversations.get(conversationId);
    if (existing) return existing;
    const created: ConversationRuntime = {
      queue: Promise.resolve(),
      pendingAborts: new Set(),
      steerInbox: [],
      steered: new Map(),
      steerDrain: Promise.resolve(),
    };
    conversations.set(conversationId, created);
    return created;
  };

  /**
   * Deliver parked steers into the conversation's ACTIVE turn, oldest first.
   * The adapter's in-flight gate is the single arbiter: a refusal (no turn
   * in flight, a harness that cannot address this session) stops the drain
   * and leaves the rest parked — order preserved, and the control plane's
   * promotion path recovers anything never delivered.
   *
   * Serialized per conversation on `steerDrain` (never awaited by the
   * reader loop's caller chain-free — both callers CHAIN onto it): the
   * removal after the await is by IDENTITY, because the entry's index can
   * shift (and the array itself be replaced by the turn-boundary prunes)
   * while the steer RPC is in flight.
   */
  const steerFromInbox = (runtime: ConversationRuntime): Promise<void> => {
    const drained = runtime.steerDrain.then(async () => {
      const turnId = runtime.activeTurnId;
      const session = runtime.session;
      if (!turnId || !session?.steer || !harness.capabilities.steer) return;
      for (;;) {
        if (runtime.steered.size >= MAX_REPORTED_STEERS) {
          log("warn", "steer outcome cap reached; the rest promote instead", {
            targetTurnId: turnId,
            parked: runtime.steerInbox.length,
          });
          return;
        }
        const entry = runtime.steerInbox.find(
          (candidate) => candidate.targetTurnId === turnId,
        );
        if (!entry) return;
        try {
          await session.steer({ id: entry.id, message: entry.message });
        } catch (error) {
          log("info", "steer refused; leaving the follow-up to promotion", {
            turnId: entry.id,
            targetTurnId: entry.targetTurnId,
            error: String(error),
          });
          return;
        }
        const index = runtime.steerInbox.indexOf(entry);
        if (index !== -1) runtime.steerInbox.splice(index, 1);
        runtime.steered.set(entry.id, false);
      }
    });
    // The chain never rejects (the body catches per-steer; a thrown drain
    // would poison every later one) — belt for the unexpected.
    runtime.steerDrain = drained.catch((error: unknown) =>
      log("warn", "steer drain failed", { error: String(error) }),
    );
    return runtime.steerDrain;
  };

  /** The active turn's steer outcomes, wire-bounded, for `turn.result`. */
  const followUpOutcomes = (
    runtime: ConversationRuntime,
  ): { turnId: string; outcome: "joined" | "missed" }[] | undefined => {
    if (runtime.steered.size === 0) return undefined;
    return [...runtime.steered.entries()]
      .slice(0, 16)
      .map(([turnId, joined]) => ({
        turnId,
        outcome: joined ? ("joined" as const) : ("missed" as const),
      }));
  };

  /**
   * Sessions start lazily, on a conversation's first turn — so a sandbox is
   * deliverable as soon as its home exists, and a container holding ten
   * idle conversations pays for none of them.
   */
  const sessionFor = async (
    runtime: ConversationRuntime,
    conversationId: string,
    resumeSessionRef: string | undefined,
  ): Promise<HarnessSession> => {
    if (runtime.session) return runtime.session;
    const session = await harness.startSession({
      homeDir: config.homeDir,
      model: config.model,
      ...(config.effort && { effort: config.effort }),
      ...(resumeSessionRef &&
        harness.capabilities.resume && { resumeSessionRef }),
      // Anchoring, not authority: lets the adapter attribute session-scoped
      // harness events (a wake request between turns) to this conversation.
      context: { conversationId },
    });
    runtime.session = session;
    log("info", "harness session started", {
      harness: harness.id,
      conversationId,
      sessionRef: session.sessionRef,
      resumed: Boolean(resumeSessionRef),
    });
    return session;
  };

  /**
   * Whether the HARNESS ITSELF died (`onFailure` fired), as opposed to one
   * turn failing on a live harness. This is what classifies a failed turn
   * for the control plane: only a dead-harness failure carries an errorCode
   * — a stale-resume `startSession` rejection, an `applyPreferences` fault,
   * any ordinary throw keeps its raw error and no code, exactly as today.
   */
  let harnessDead = false;

  /** The failure class for a failed `turn.result`, or undefined for an
   * ordinary (live-harness) failure. `streamStarted` supplies the phase:
   * pre-stream means the harness died before ANY observable work — the
   * control plane may revive that turn invisibly; post-stream deaths must
   * stay visible (side effects may exist). */
  const failureCode = (runtime: ConversationRuntime): string | undefined =>
    harnessDead
      ? runtime.streamStarted
        ? TURN_FAILURE_CODES.agentRestarted
        : TURN_FAILURE_CODES.agentStartFailed
      : undefined;

  const runTurn = async (
    item: Extract<WorkItem, { kind: "turn.deliver" }>,
  ): Promise<void> => {
    const runtime = runtimeFor(item.conversationId);
    let sawCleanEnd = false;
    let usage: TurnUsage | undefined;
    /** The harness's terminal `error` message, kept for failure classing. */
    let terminalError: string | undefined;
    /** The terminal `error` event's protocol code, when the adapter minted
     * one — today only `harness_busy` (the adapter's self-heal exhausting). */
    let terminalErrorCode: string | undefined;
    /** Set on the failure arms: a turn that ended `failed` without a clean
     * terminal may have left the harness still executing its run — the
     * `finally` cancels it so an orphan can never burn for half an hour
     * under a row nobody is reading (proven live in the incident). */
    let uncleanFailure = false;
    /** How this turn ended, for the `finally`'s safety net: done/failed
     * turns get their leftover background work watched; aborted turns do
     * not (stop means silence). */
    let endedStatus: "done" | "failed" | "aborted" | undefined;

    /**
     * The failure class for this turn. A DEATH code always outranks
     * everything — the death codes carry lifecycle semantics (revival,
     * visibility, the unhealthy recycle) no other code may usurp; a dying
     * harness whose last words mention a rate limit is still a dead harness.
     * `harness_busy` comes only from the terminal error EVENT's code (the
     * adapter mints it; the catch arm's raw throw never does), and outranks
     * the provider-refusal prose match.
     */
    const classify = (raw: string | undefined): string | undefined =>
      failureCode(runtime) ??
      (terminalErrorCode === TURN_FAILURE_CODES.harnessBusy
        ? TURN_FAILURE_CODES.harnessBusy
        : raw && isTrialCreditExhausted(raw)
          ? TURN_FAILURE_CODES.trialCreditExhausted
          : raw && isProviderRefusal(raw)
            ? TURN_FAILURE_CODES.modelProviderError
            : undefined);

    /** Everything the agent said this turn, rebuilt from the deltas. */
    let answer = "";
    let answerSent = false;
    /**
     * A tool batch or a thinking block between text deltas marks a message
     * boundary — the model ended one message and later started another. The
     * raw concatenation glued them mid-sentence ("…a different address?Got
     * it — no email…", observed live); a blank line renders as a paragraph
     * break instead. Only these interleaved events are visible boundaries:
     * the vendor stream carries no message framing, so two messages with
     * nothing between them still concatenate (accepted residual).
     */
    let boundarySinceText = false;
    /**
     * Send the accumulated answer exactly once, whatever ends the turn —
     * cleanly, with an error, by abort, or by the stream simply stopping. A
     * partial answer is still what the user watched arrive, so it is still
     * what the transcript owes them.
     */
    const emitAnswer = () => {
      if (answerSent || !answer) return;
      answerSent = true;
      transport.send({
        kind: "event",
        turnId: item.turnId,
        conversationId: item.conversationId,
        event: { type: "text", text: answer },
      });
    };

    // Claimed BEFORE the session is awaited: starting one takes real time, and
    // an abort arriving in that window must find a turn to attach to. The
    // stream is not live yet — an abort now parks (pendingAborts), it does
    // not fire against the idle session.
    runtime.activeTurnId = item.turnId;
    runtime.streamStarted = false;
    /** Whether THIS turn was the one an abort cancelled. */
    const wasAborted = () => runtime.abortedTurnId === item.turnId;

    // The turn-liveness heartbeat: while this turn is in flight, tell the
    // control plane it is alive on a timer — whatever the agent is doing.
    // Turn events can go quiet for a long time legitimately (a bg wait, a
    // swarm await, hidden reasoning), so liveness is THIS process being up,
    // not the transcript moving; the stall arm fails the turn when these
    // stop. Started with the claim (a turn waiting on the session or the
    // sync queue is alive too), unref'd per the house law (observer.ts —
    // no supervisor handle may hold a finished container's event loop), and
    // cleared first in the `finally`. Frames buffering while the channel is
    // down are fine: the outbound cap drops oldest, and delivery after a
    // reconnect just stamps late.
    const progressTimer = setInterval(() => {
      transport.send({
        kind: "progress",
        turnId: item.turnId,
        conversationId: item.conversationId,
      });
    }, config.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
    progressTimer.unref();

    // Steer bookkeeping starts clean, and entries aimed at any OTHER turn are
    // pruned: the conversation serializes turns, so once this one is active
    // every other target is terminal — those entries can never join, and the
    // control plane's promotion path already owns them.
    runtime.steerInbox = runtime.steerInbox.filter(
      (entry) => entry.targetTurnId === item.turnId,
    );
    runtime.steered = new Map();

    try {
      // The boot-seed guarantee: a turn never starts ahead of an in-flight
      // home apply — without this, the very first turn could read an
      // empty memory/ while the boot sync's writes are still landing (syncs
      // are ORDERED before turns on the socket, but they apply on their own
      // chain). AFTER the claim above, so an abort landing during this wait
      // attaches (pendingAborts) instead of being dropped. The chain is
      // never-throwing (the poison guard), so the await is bounded by the
      // applies themselves — every harvest inside them carries a timeout.
      await syncQueue;

      const session = await sessionFor(
        runtime,
        item.conversationId,
        item.resumeSessionRef,
      );

      // An abort that landed while the session was starting applies to this
      // turn — honour it instead of running the turn it was meant to stop.
      if (runtime.pendingAborts.delete(item.turnId)) {
        log("info", "abort applied before the turn began", {
          conversationId: item.conversationId,
          turnId: item.turnId,
        });
        endedStatus = "aborted";
        transport.send({
          kind: "turn.result",
          turnId: item.turnId,
          conversationId: item.conversationId,
          status: "aborted",
          ...(session.sessionRef && { sessionRef: session.sessionRef }),
        });
        return;
      }

      // The delivery-only context (step 8: the memory index) is prepended
      // HERE, at the harness boundary — the wire stays honest about message
      // vs context, and the stored transcript never contains the frame.
      // The EMPTY-PROMPT GUARD is load-bearing, not cosmetic: a file-only
      // message on a path with no context (a runner without the attachments
      // capability, a failed context build) would otherwise hand the harness
      // an empty string, which jcode turns into an empty text block the
      // model API rejects with a 400 (verified in v0.71.1; v0.81.1 still
      // passes the content through verbatim, no filtering).
      const composed = item.context
        ? `${item.context}\n\n${item.message}`
        : item.message;
      const prompt =
        composed.trim().length > 0
          ? composed
          : "(the user sent attachments with no message)";
      // Inline vision: image attachments already materialized on the home
      // disk (the parts preceded this frame and runTurn awaited the sync
      // chain) are re-read and handed to the harness with the message, so
      // the model sees them without choosing to. Budget-packed ascending so
      // the most images fit; everything stays readable from disk regardless.
      const images = collectInlineImages(item.attachments);
      // The stream is now live: from here an abort has a run to cancel, so
      // it fires against the session rather than parking. Set synchronously
      // (no await) right after the pending-abort check above, so no abort
      // can slip into the gap between "checked" and "streaming".
      runtime.streamStarted = true;
      let drainedSteers = false;
      for await (const event of session.runTurn({
        message: prompt,
        ...(images.length > 0 && { images }),
      })) {
        // Follow-ups that arrived before the harness accepted this turn's
        // message drain on the FIRST event — the earliest moment the
        // adapter's in-flight gate is open.
        if (!drainedSteers) {
          drainedSteers = true;
          await steerFromInbox(runtime).catch((error: unknown) =>
            log("warn", "steer drain failed", { error: String(error) }),
          );
        }

        // The adapter confirmed a steered follow-up was consumed by this
        // run. Only ids this supervisor actually delivered are honored — an
        // adapter cannot mint outcomes for messages it was never handed.
        if (
          event.type === "message.joined" &&
          runtime.steered.has(event.followUpId)
        ) {
          runtime.steered.set(event.followUpId, true);
        }

        // Accumulate what we forward. The deltas themselves are ephemeral by
        // design (§3.17), and this supervisor is the only party that sees the
        // whole stream — so if it does not keep the answer, nothing can.
        //
        // BOUNDED, because this process runs inside a container executing
        // model-driven output: a model that loops would otherwise grow this
        // string until the sandbox is killed for memory. The cap sits well
        // above the wire's own limit so the VISIBLE truncation stays the
        // runner's job and a reader sees one marker, not two.
        if (event.type === "text.delta" && answer.length < MAX_ANSWER_CHARS) {
          // The separator rides inside the same cap guard and only ever
          // follows existing text — it can neither make an empty answer
          // non-empty nor grow a capped one.
          if (boundarySinceText && answer !== "" && !answer.endsWith("\n\n")) {
            answer += "\n\n";
          }
          boundarySinceText = false;
          answer += event.text;
        }
        if (
          event.type === "tool.started" ||
          event.type === "tool.finished" ||
          event.type === "thinking.delta"
        ) {
          boundarySinceText = true;
        }

        // The answer goes out BEFORE the terminal event, not after: `seq` is
        // assigned in arrival order, so emitting it afterwards would place the
        // reply below the marker that says the turn ended.
        if (isTerminalEvent(event)) emitAnswer();

        transport.send({
          kind: "event",
          turnId: item.turnId,
          conversationId: item.conversationId,
          event,
        });
        if (event.type === "turn.done") {
          sawCleanEnd = true;
          usage = event.usage;
        }
        if (event.type === "error") {
          terminalError = event.message;
          terminalErrorCode = event.code;
        }
      }

      // A stream that ended without a terminal event still said something.
      emitAnswer();

      const followUps = followUpOutcomes(runtime);
      // `aborted` wins over `done`: an aborted stream ends cleanly, so the
      // clean end tells us nothing about whether the user cancelled.
      const status = wasAborted() ? "aborted" : sawCleanEnd ? "done" : "failed";
      // A stream that ended failed without throwing can still be a death —
      // the adapter's `close` rides the same teardown as the stream's end
      // with no ordering contract, so give `fail()` one macrotask to land
      // before classifying (same law as the catch arm below).
      if (status === "failed" && !harnessDead) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const errorCode =
        status === "failed" ? classify(terminalError) : undefined;
      uncleanFailure = status === "failed" && !harnessDead;
      endedStatus = status;
      transport.send({
        kind: "turn.result",
        turnId: item.turnId,
        conversationId: item.conversationId,
        status,
        ...(errorCode && { errorCode }),
        // The raw refusal rides beside the code — the control plane stores
        // only the canonical copy and keeps this for its server log (and an
        // old control plane's raw passthrough matches the catch arm below).
        // `harness_busy` attaches it too, as the version-skew guard: an old
        // control plane that ignores the code then stores visible text
        // instead of regressing to the silent NULL shape. Uncoded failures
        // keep today's shape: no error field, the transcript stream's own
        // error event is the witness. Sliced at the source per the
        // transport's truncate-at-sender law: this frame must deliver.
        ...((errorCode === TURN_FAILURE_CODES.modelProviderError ||
          errorCode === TURN_FAILURE_CODES.trialCreditExhausted ||
          errorCode === TURN_FAILURE_CODES.harnessBusy) &&
          terminalError && {
            error: terminalError.slice(0, MAX_TURN_RESULT_ERROR_CHARS),
          }),
        ...(usage && { usage }),
        ...(runtime.session?.sessionRef && {
          sessionRef: runtime.session.sessionRef,
        }),
        ...(followUps && { followUps }),
      });
    } catch (error) {
      // Even a turn that threw mid-stream said something first.
      emitAnswer();
      log("error", "turn failed", {
        conversationId: item.conversationId,
        turnId: item.turnId,
        error: String(error),
      });
      // The SDK's stream rejection and the adapter's `close` event ride the
      // same socket teardown with no ordering contract — one macrotask lets
      // `fail()` land so a death is classified as one, not raced into an
      // uncoded raw error.
      if (!harnessDead) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const errorCode = wasAborted() ? undefined : classify(String(error));
      uncleanFailure = !wasAborted() && !harnessDead;
      endedStatus = wasAborted() ? "aborted" : "failed";
      const followUps = followUpOutcomes(runtime);
      transport.send({
        kind: "turn.result",
        turnId: item.turnId,
        conversationId: item.conversationId,
        status: wasAborted() ? "aborted" : "failed",
        // Sliced at the source, same law as above — a harness error can be
        // arbitrarily large, and this terminal frame must deliver.
        error: String(error).slice(0, MAX_TURN_RESULT_ERROR_CHARS),
        ...(errorCode && { errorCode }),
        ...(runtime.session?.sessionRef && {
          sessionRef: runtime.session.sessionRef,
        }),
        ...(followUps && { followUps }),
      });
    } finally {
      clearInterval(progressTimer);
      runtime.activeTurnId = undefined;
      runtime.pendingAborts.delete(item.turnId);
      if (runtime.abortedTurnId === item.turnId) {
        runtime.abortedTurnId = undefined;
      }
      // This turn's steer bookkeeping dies with it: undelivered entries are
      // the promotion path's, and delivered outcomes just went out on the
      // terminal report.
      runtime.steerInbox = runtime.steerInbox.filter(
        (entry) => entry.targetTurnId !== item.turnId,
      );
      runtime.steered = new Map();
      // THE DEFENSIVE ABORT. A turn that ended `failed` without a clean
      // terminal may have walked away from a run the harness is still
      // executing — which then burns invisibly under a row nobody reads
      // (23 minutes, live) and blocks the session for the next message.
      // Cancel it. AWAITED, not fire-and-forget: the conversation queue
      // advances when this `finally` resolves, and an unawaited cancel could
      // be written to the socket AFTER the next turn's send — killing the
      // fresh run instead of the orphan. The terminal `turn.result` is
      // already out (sent in the arms above), so nothing user-facing waits
      // on this; worst case on a wedged harness is one request timeout
      // delaying only this conversation's next turn, which is blocked on
      // the wedged session anyway. Deliberately NOT via `abort()`/
      // `abortedTurnId` — this is cleanup, and a failure must never be
      // re-reported as a user cancel.
      if (uncleanFailure && runtime.streamStarted && runtime.session) {
        await runtime.session
          .abort()
          .catch((error: unknown) =>
            log("warn", "defensive abort failed", { error: String(error) }),
          );
      }
      // THE TURN-END SAFETY NET. Background work left running with nothing
      // armed to report it completes invisibly: the running row keeps the
      // machine awake, but no wake source exists, so the RESULT reaches no
      // one (observed live — "I'll report back", then silence). Arm a
      // default exit-watch on every such process. Aborted turns are
      // excluded (stop means silence), and a dead harness is going down
      // with its processes — N "lost" wake turns on top of the restart
      // notice would be noise.
      if (
        (endedStatus === "done" || endedStatus === "failed") &&
        !harnessDead
      ) {
        // Caught like the defensive abort above: a throw inside a `finally`
        // would mask the turn's real completion — the net is best-effort.
        try {
          const armed = processes.armTurnEndSafetyNet({
            conversationId: item.conversationId,
            turnId: item.turnId,
          });
          if (armed > 0) {
            log("info", "turn-end safety net armed exit watches", {
              conversationId: item.conversationId,
              turnId: item.turnId,
              armed,
            });
          }
        } catch (error) {
          log("warn", "turn-end safety net failed", { error: String(error) });
        }
      }
    }
  };

  /**
   * Stop the named turn if it is the one running. Checking the id matters:
   * an abort that arrives just after its turn ended must not cancel the next
   * one, which by then may already be underway.
   */
  const abort = async (turnId: string, conversationId: string) => {
    const runtime = conversations.get(conversationId);
    if (!runtime || runtime.activeTurnId !== turnId) {
      log("info", "abort for a turn that is not running", {
        conversationId,
        turnId,
      });
      return;
    }

    // The turn is the active one but its harness stream is not live yet —
    // during session startup OR the pre-stream sync-await (the boot-seed
    // guarantee makes runTurn wait out the home-sync chain, which can
    // span harvest round-trips). `session.abort()` here would no-op against
    // an idle session and the turn would then run to completion while being
    // reported "aborted". Park instead: runTurn re-checks pendingAborts
    // after the awaits and honours it before streaming. Keyed on
    // `streamStarted`, not `session`, because a session survives across a
    // conversation's turns — for turn N≥2 the session exists but the new
    // turn's stream has not begun.
    if (!runtime.streamStarted) {
      runtime.pendingAborts.add(turnId);
      log("info", "abort queued until the turn's stream begins", {
        conversationId,
        turnId,
      });
      return;
    }

    log("info", "aborting turn", { conversationId, turnId });
    runtime.abortedTurnId = turnId;
    await runtime.session?.abort();
  };

  /**
   * A HARNESS THAT DIED TAKES THE SANDBOX WITH IT.
   *
   * Once the runtime behind the adapter is gone, nothing in this container can
   * serve a turn again — not this conversation, not a brand-new one. Yet from
   * every angle outside it the sandbox still looks healthy: the container runs,
   * the control channel is connected, and the control plane keeps dispatching
   * to it. Observed live: one crash, and every message from then on failed
   * with "harness connection closed".
   *
   * So the failure is REPORTED and this process ends. The control plane marks
   * the sandbox stopped, the container exits, and the next message takes the
   * ordinary wake path into a fresh container — no new recovery machinery,
   * just the truth put where recovery already looks for it.
   */
  const harnessFailed = new Promise<void>((resolve) => {
    harness.onFailure((reason) => {
      // Before anything else: in-flight turns classify their failure off this
      // flag (see `failureCode`), and their catch arms may already be racing
      // this handler on the same teardown.
      harnessDead = true;
      log("error", "harness failed; reporting the sandbox unhealthy", {
        harness: harness.id,
        reason,
      });
      transport.send({
        kind: "unhealthy",
        // Truncated HERE, not merely validated at the far end: an adapter's
        // error string has no length contract, and one that overruns the wire
        // cap is rejected as invalid and dropped — which is exactly the silent
        // brick this message exists to prevent.
        reason: reason.slice(0, MAX_UNHEALTHY_REASON_CHARS),
      });
      resolve();
    });
  });

  transport.send({ kind: "ready", harness: harness.id });

  try {
    // An explicit iterator, not `for await`, so the read can be raced against
    // the failure signal: a `for await` parked on the next frame cannot be
    // interrupted, and the whole point is to stop reading work this container
    // can no longer do.
    //
    // The raced promise is built ONCE. Deriving it inside the loop would add a
    // reaction to `harnessFailed` per work item and never remove it — a
    // container that serves thousands of turns would accumulate thousands of
    // closures on a promise that, in the healthy case, never settles.
    const items = transport.incoming()[Symbol.asyncIterator]();
    const failureSignal = harnessFailed.then(() => "harness-failed" as const);
    for (;;) {
      const read = items.next();
      const next = await Promise.race([read, failureSignal]);
      if (next === "harness-failed") {
        // The read we are walking away from may still reject later — a
        // transport whose underlying stream errors after we stopped caring.
        // Nothing would be listening, and an unhandled rejection is fatal in
        // Node: the container would die on the failure path with a stack
        // trace instead of the orderly teardown below.
        void read.catch(() => undefined);
        break;
      }
      if (next.done) break;
      const item = next.value;

      if (item.kind === "shutdown") {
        log("info", "shutdown requested");
        break;
      }

      if (item.kind === "turn.abort") {
        // Handled inline, not queued — queueing an abort behind the turn it
        // cancels is the exact bug this shape exists to prevent.
        await abort(item.turnId, item.conversationId).catch((error: unknown) =>
          log("warn", "abort failed", { error: String(error) }),
        );
        continue;
      }

      if (item.kind === "turn.message") {
        // Inline like abort, and for the same reason: a steer queued behind
        // the very turn it should join would arrive after that turn ended.
        // Inbox first, then attempt — the adapter's in-flight gate is the
        // delivery arbiter, and an entry it refuses stays parked for the
        // turn's own drain (or, ultimately, the control plane's promotion).
        const runtime = runtimeFor(item.conversationId);
        if (runtime.steerInbox.length >= MAX_STEER_INBOX) {
          log("warn", "steer inbox full; leaving the follow-up to promotion", {
            conversationId: item.conversationId,
            turnId: item.turnId,
          });
          continue;
        }
        runtime.steerInbox.push({
          targetTurnId: item.targetTurnId,
          id: item.turnId,
          message: item.message,
        });
        if (runtime.activeTurnId === item.targetTurnId) {
          await steerFromInbox(runtime).catch((error: unknown) =>
            log("warn", "steer failed", { error: String(error) }),
          );
        }
        continue;
      }

      if (item.kind === "tool.result") {
        // Inline like abort, and for the same reason: this resolves a map
        // entry a tool call is awaiting — queueing it behind the very turn
        // that made the call would deadlock until the correlator timeout.
        platformTools.handleToolResult(item);
        continue;
      }

      if (item.kind === "memory.write.result") {
        // Inline like tool.result, and MORE so: a sync apply can be awaiting
        // this exact answer through the materializer's harvest gate —
        // queueing it behind the sync chain would deadlock into the
        // harvester's timeout.
        harvester.handleResult(item);
        continue;
      }

      if (item.kind === "attachment.part") {
        // Chained like skills.changed (real I/O; awaiting would stall the
        // reader and therefore aborts) but with its OWN catch: an attachment
        // failure is per-file — the agent's read reports it — and must never
        // set or consult the home-sync generation poison, whose job is
        // keeping projection acks honest.
        syncQueue = syncQueue
          .then(() => attachmentAssembler.apply(item))
          .catch((error: unknown) => {
            log("warn", "attachment apply failed; file skipped", {
              attachmentId: item.attachmentId,
              error: String(error),
            });
          });
        continue;
      }

      if (item.kind === "skills.changed") {
        // Inline like the two above — a materialization queued behind a
        // running turn would defeat "within a second, while the agent runs"
        // — but chained, never awaited: this is the first inline arm doing
        // real I/O, and awaiting it would stall the reader (and therefore
        // aborts) for the duration of the writes. The `.catch` is the same
        // poison guard the turn chains carry.
        //
        // POISONING IS PER-GENERATION, and that is what keeps the ack honest.
        // Without it the `.catch` would recover the chain, the FINAL part
        // would still prune and ack, and the control plane would mark a
        // half-written projection complete — permanently, since nothing
        // retries an applied generation. Skipping the rest of a failed
        // generation instead leaves `applied` behind, and the paced re-push
        // is the retry. A new generation clears it by construction.
        syncQueue = syncQueue
          .then(() => {
            if (poisonedSyncGeneration === item.generation) return;
            return applySync(
              config.homeDir,
              item,
              renderInputs,
              (message) => transport.send(message),
              harvester,
            );
          })
          .catch((error: unknown) => {
            poisonedSyncGeneration = item.generation;
            log("warn", "home sync failed; no ack for this generation", {
              generation: item.generation,
              error: String(error),
            });
          });
        continue;
      }

      // Chain onto this conversation, then keep reading.
      //
      // The `.catch` is not defensive dressing: `runTurn` sends on the
      // transport from BOTH its try and its catch, and a write to a dying
      // socket throws. A rejected tail poisons the chain permanently — every
      // later `.then` short-circuits, so that conversation silently stops
      // running turns for the life of the container.
      // Everything above `continue`s, so the only shape that reaches here is
      // turn.deliver. Asserting it keeps a future work-item arm from
      // compiling into this branch and being run as a turn.
      if (item.kind !== "turn.deliver") {
        const unreachable: never = item;
        log("warn", "unhandled work item", {
          item: JSON.stringify(unreachable),
        });
        continue;
      }

      const runtime = runtimeFor(item.conversationId);
      runtime.queue = runtime.queue
        .then(() => runTurn(item))
        .catch((error: unknown) =>
          log("error", "turn chain failed", {
            conversationId: item.conversationId,
            turnId: item.turnId,
            error: String(error),
          }),
        );
    }

    // Let in-flight turns finish reporting before the harness goes away. On
    // the failure path they are exactly the turns that must not be left
    // hanging: each one fails fast against the dead harness and sends its own
    // terminal result, which is what unblocks its conversation now rather than
    // at the control plane's stale-turn sweep.
    await Promise.allSettled([
      ...[...conversations.values()].map((c) => c.queue),
      // A final sync's ack must flush before the transport closes.
      syncQueue,
    ]);
    // NOT the harvester here: once the reader loop has ended, no
    // `memory.write.result` can be routed to `handleResult`, so any upload a
    // shutdown-time flush sends would wait out its full 25s correlator
    // timeout, serially, for nothing — stalling teardown past the docker-stop
    // grace. A file written in the final seconds is safe regardless: it lives
    // on the durable volume and the NEXT boot's harvest uploads it. The
    // durable volume, not a shutdown flush, is the tail guarantee.
  } finally {
    // The observer first — its next tick must not resurrect entries the
    // manager is about to drop.
    observer?.stop();
    // The harvester next: stops its timer and resolves every pending write
    // await (as timeouts), so nothing below waits on answers that cannot
    // arrive once the transport closes.
    harvester.stop();
    // Background children next: SIGTERM their groups and destroy their pipes
    // (open pipe handles would otherwise hold this process past the loop's
    // end). Sends nothing — once the container stops the control plane's
    // lost sweep owns the truth.
    processes.close();
    // Disposing a harness that ALREADY died is the common case on the failure
    // path, and a vendor client can reject when its process is gone. Letting
    // that throw would skip the release below and turn an orderly teardown
    // into a crash — with the socket still open.
    await harness
      .dispose()
      .catch((error: unknown) =>
        log("warn", "harness dispose failed", { error: String(error) }),
      );
    // Before the transport goes: rejects every pending tool call into an
    // error the bridge can still deliver, instead of leaving an MCP call
    // hanging into the vendor's own timeout.
    await platformTools
      .close()
      .catch((error: unknown) =>
        log("warn", "platform tools close failed", { error: String(error) }),
      );
    // LAST, once nothing else will send: releases the socket, without which
    // this process would sit open with nothing left to do.
    await transport.close();
  }
};
