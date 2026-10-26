import {
  bareToolName,
  isInlineableImage,
  isPlatformSteerId,
  isTerminalEvent,
  INLINE_IMAGES_TOTAL_MAX_BYTES,
  MAX_TURN_RESULT_ERROR_CHARS,
  MAX_UNHEALTHY_REASON_CHARS,
  TURN_FAILURE_CODES,
  type AgentConnectionWire,
  type AttachmentManifestEntry,
  type BackgroundedTool,
  type Harness,
  type HarnessSession,
  type SupervisorTransport,
  type TurnImage,
  type TurnUsage,
  type WorkItem,
} from "@onecli/agent-protocol";
import type { SupervisorConfig } from "./config";
import {
  createAnswerTracker,
  MAX_ANSWER_CHARS,
  replyTargetOf,
  toWireEvent,
} from "./answer";
import { log } from "./log";
import {
  isProviderRefusal,
  isModelEndpointNotFound,
  isTranscriptRejected,
  isTrialCreditExhausted,
} from "./provider-refusal";
import { renderHome, type RenderInputs } from "./home/renderer";
import { applyHomeSync } from "./home/materializer";
import {
  createAttachmentAssembler,
  pruneStaleAttachments,
  readMaterializedAttachment,
} from "./home/attachments";
import { startPlatformTools } from "./platform-tools";
import { attachmentsFragment } from "./capabilities/attachments";
import { agentsTools } from "./capabilities/agents";
import { channelsChangeNote, channelsTools } from "./capabilities/channels";
import {
  connectionsChangeNote,
  connectionsFragment,
  connectionsTools,
} from "./capabilities/connections";
import { cronsFragment, cronsTools } from "./capabilities/crons";
import { webhooksFragment, webhooksTools } from "./capabilities/webhooks";
import {
  createSendFileTools,
  sendFileFragment,
} from "./capabilities/send-file";
import {
  reservedGuestPorts,
  createPortStreams,
  isPortWorkItem,
} from "./capabilities/port-streams";
import { startPortDiscovery } from "./capabilities/port-discovery";
import type { SupervisorAddon, SupervisorAddonHost } from "./addons";
import { machineFragment } from "./capabilities/machine";
import { memoryFragment, memoryTools } from "./capabilities/memory";
import { previewsFragment, previewsTools } from "./capabilities/previews";
import { skillsFragment, skillsTools } from "./capabilities/skills";
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
 * Cadence of the turn-liveness heartbeat (`progress` frames). Comfortably
 * inside the control plane's stall window (TURN_STALL_SECONDS, default 600s)
 * so one dropped frame never reads as a wedge, and cheap enough to run
 * unconditionally for every in-flight turn. A constant, not an env knob —
 * the stall window is the tunable; the heartbeat just has to beat it.
 */
export const PROGRESS_INTERVAL_MS = 60_000;

/**
 * How long a first turn waits for its session to take the platform tool
 * list from our bridge. jcode discovers MCP tools asynchronously and serves
 * its on-disk cache (`.jcode-home/mcp-schema-cache.json`) until that lands,
 * so without this wait the first turn after a deploy that CHANGED the tool
 * set advertises the old one — observed live as `complete_task` reading
 * "unknown tool". Measured live at 64ms on a cold start and 95ms on a
 * resume, so the bound is pure headroom for a loaded container; it is paid
 * once per session start, and only until the listing arrives.
 *
 * A ceiling, not a delay: exceeding it logs and proceeds, because a harness
 * that never asks (no MCP bridge at all) must still be able to answer.
 */
const TOOL_LISTING_WAIT_MS = 10_000;

/**
 * The gap between jcode ASKING this bridge for its tools and that answer
 * being live in the session. We can observe the request but not the
 * registration (the SDK exposes no MCP-ready event), so this is the one
 * unavoidable sleep — deliberately small, paid once per session start.
 *
 * Measured live (A/B over a resumed ref across a tool-set change): with no
 * settle the first turn still carried the on-disk cached list; with 500ms
 * it carried the new one. 1s keeps margin for a slower container without
 * being felt — a session start already costs far more than this.
 */
const TOOL_REGISTRATION_SETTLE_MS = 1_000;

/**
 * The signal path (index.ts) exits immediately without running the loop's
 * `finally`, so a running supervisor registers synchronous cleanups here
 * that the handler runs before `process.exit`: SIGTERM'ing every background
 * process group so children get their flush chance, and taking the desktop
 * down. A plain module-level hook avoids threading the manager up into
 * index.ts. Each registration is kept (never replaced): the pieces that
 * need a last word are started by different modules.
 */
const signalCleanups: (() => void)[] = [];
export const registerSignalCleanup = (fn: () => void): void => {
  signalCleanups.push(fn);
};
export const runSignalCleanup = (): void => {
  for (const fn of signalCleanups) {
    try {
      fn();
    } catch {
      // best-effort: the container is about to die regardless
    }
  }
};

/** A mid-run follow-up waiting to steer into its target turn. */
interface SteerInboxEntry {
  targetTurnId: string;
  /** The follow-up row's id — the outcome's correlation key. */
  id: string;
  message: string;
  /** The delivery-only frame (the "new message" marker), composed in
   * front of the words at the harness boundary like a turn's context. */
  context?: string;
  /**
   * The follow-up's own files: their manifest, and whether their parts
   * (applied on the sync chain ahead of this entry) are on disk yet. The
   * drain hands over only an entry whose files have landed, so it never
   * waits on a file write; the landing itself drains again.
   */
  files?: {
    manifest: AttachmentManifestEntry[];
    landed: Promise<void>;
    ready: boolean;
  };
}

/**
 * The model-facing text for a message: the delivery-only context the control
 * plane framed it with, then the words. Composed HERE, at the harness
 * boundary, for a turn and for a steer alike: the wire stays honest about
 * message vs context, and the stored transcript never contains the frame.
 */
const composePrompt = (message: string, context: string | undefined): string =>
  context ? `${context}\n\n${message}` : message;

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
  /**
   * Platform tools the active turn's harness session has OPEN right now
   * (bare name -> open count), fed by `tool.started` / `tool.finished`. The
   * seam that attributes an MCP call to its conversation when two turns are
   * in flight: the harness emits `tool_start` on the calling session's
   * stream before the bridge's socket request arrives, so the one
   * conversation with that tool open is the caller. Cleared per turn.
   */
  openTools: Map<string, number>;
  /**
   * Set when the agent's surface changed under a live session — a chat
   * presence attached or removed while this conversation's session was
   * already running. jcode captures the instruction doc and the MCP tool
   * list at session start, so the running session would keep answering from
   * the OLD doc (an agent attached to Slack mid-run told a Slack user it had
   * no Slack access — observed live, 2026-09-15). The next turn on this
   * conversation drops the session and starts a fresh one over the same
   * resume ref, which re-reads the doc and re-lists the tools. Never applied
   * to an IN-FLIGHT turn: the flag waits for the turn to end.
   */
  surfaceStale?: boolean;
  /**
   * What changed on the surface since this conversation's last turn, as one
   * line the NEXT turn carries as context. Set with `surfaceStale`; cleared
   * when consumed. The re-rendered doc says the new state; this says that
   * it changed, in the model's most recent input, where two turns of "my
   * app was removed" would otherwise win over the doc (observed live).
   */
  surfaceNote?: string;
}

export const runSupervisor = async (
  config: SupervisorConfig,
  harness: Harness,
  transport: SupervisorTransport,
  deps?: {
    applySync?: typeof applyHomeSync;
    processManager?: ProcessManager;
    memoryHarvester?: MemoryHarvester;
    /** A capability the entrypoint added for this sandbox (addons.ts). */
    addon?: SupervisorAddon;
  },
): Promise<void> => {
  const applySync = deps?.applySync ?? applyHomeSync;
  const addon = deps?.addon;
  // MUTABLE on purpose (step 9): a home sync's final part carries fresh
  // instructions/agentName and re-renders from this same holder — a dashboard
  // brief edit reaches the docs mid-run.
  const renderInputs: RenderInputs = {
    instructions: config.instructions,
    agentName: config.agentName,
    // The channels section is DERIVED from this on every render (renderer.ts)
    // rather than registered as a static fragment: the presence list is a
    // render input like the brief, refreshed by the home sync mid-run.
    channels: config.channels,
    // The agents section follows the same law, from the peer roster.
    peers: config.peers,
    // And the connected-apps list (with each host-bound app's host).
    connections: config.connections,
    capabilities: harness.capabilities,
    // The §3.7 registry: each enabled capability contributes its fragment
    // here and its tools below — they arrive together, disappear together.
    // Connections leads and is unconditional: the gateway is a platform
    // property, not a harness capability, and gateway-first is the rule the
    // agent must hold before its first external call — only its skill-path
    // bullet depends on the adapter. Connections is fragment-only (no
    // tools); skills — fragment AND its skill_* tools — is present only
    // when the adapter declares a skills directory.
    fragments: [
      connectionsFragment(harness.capabilities.skillsDir),
      cronsFragment,
      // Unconditional like crons: webhooks are a hosted-agent platform
      // property, and the tools answer "none yet" when there are none.
      webhooksFragment,
      memoryFragment,
      // The channels section (where the agent can be talked to, and the
      // send_message/find_recipient teaching) is spliced in HERE by the
      // renderer when the agent holds a presence — standing surface truth,
      // beside memory and ahead of the machine sections.
      processesFragment,
      // Unconditional like connections: what survives sleep/relaunch is a
      // substrate property. The browsing bullet follows the desktop the
      // supervisor brought up (index.ts exports DISPLAY before this runs).
      machineFragment(process.env.DISPLAY ?? null),
      // After machine: it extends "what is here" with "how a person sees
      // it". Fragment and preview_expose arrive together, and only where
      // the runner carries port streams.
      ...(config.previews ? [previewsFragment] : []),
      // A deployment's addon, after the machine sections it extends. Its
      // fragments are fixed at boot, like its tools below.
      ...(addon?.fragments ?? []),
      // Unconditional like connections: receiving files is a platform
      // property (every harness can read a file), not an adapter capability.
      attachmentsFragment,
      // SENDING files (Tier 3) needs a runner that relays them; the fragment
      // and its tool arrive together and only then — an agent must never be
      // taught a tool it does not have.
      ...(config.outboundAttachments ? [sendFileFragment] : []),
      ...(harness.capabilities.skillsDir
        ? [skillsFragment(harness.capabilities.skillsDir)]
        : []),
    ],
    channelsAfter: memoryFragment.id,
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

  // A wake a preview hit caused brings the apps behind the agent's shares
  // back (the relaunch commands the agent registered with preview_expose),
  // as ordinary background processes: the same spawn, caps, frames and
  // keep-awake as a process_start. No watch is armed — a server has no
  // "done" to report, and a platform-armed one would only add noise. The
  // viewer meanwhile sits on the relay's auto-refreshing page.
  for (const { port, command } of config.previewRelaunch ?? []) {
    const started = processes.start({ command, name: `preview:${port}` }, null);
    log(started.ok ? "info" : "warn", "preview app relaunch", {
      port,
      ...(started.error && { error: started.error }),
    });
  }

  const conversations = new Map<string, ConversationRuntime>();

  // The home-sync chain (step 9): its own serialized queue, separate
  // from every conversation queue — the reader NEVER awaits it, so aborts
  // stay live while files write.
  let syncQueue: Promise<void> = Promise.resolve();
  /** The generation whose apply threw — its remaining parts are skipped so no
   * ack is ever sent for an incomplete projection. */
  let poisonedSyncGeneration: number | null = null;

  // Attributes work to the calling turn only when that is unambiguous,
  // because a wrong anchor is worse than none. One active turn: that one.
  // Several: the ONE whose session has `toolName` open right now (the
  // harness announces a tool call on the calling session's event stream
  // before the MCP bridge dials the socket, see `openTools`); with no name,
  // or with the tool open in none or several, null. Shared by the
  // platform-tool channel and the background-task observer (both anchor
  // arm-time context the same way). Observed live (2026-09-16): a person's
  // question in one conversation and a peer's message in another put two
  // turns in flight, and the person's `message_agent` lost its origin.
  const activeTurn = (
    toolName?: string,
  ): { conversationId: string; turnId: string } | null => {
    let found: { conversationId: string; turnId: string } | null = null;
    let ambiguous = false;
    for (const [conversationId, runtime] of conversations) {
      if (!runtime.activeTurnId) continue;
      if (found) {
        ambiguous = true;
        break;
      }
      found = { conversationId, turnId: runtime.activeTurnId };
    }
    if (!ambiguous) return found;
    if (!toolName) return null;
    const bare = bareToolName(toolName);
    let owner: { conversationId: string; turnId: string } | null = null;
    for (const [conversationId, runtime] of conversations) {
      if (!runtime.activeTurnId || !(runtime.openTools.get(bare) ?? 0)) {
        continue;
      }
      if (owner) return null; // the same tool open in two sessions
      owner = { conversationId, turnId: runtime.activeTurnId };
    }
    return owner;
  };

  // The platform-tool channel (step 7): the harness's MCP bridge dials the
  // local socket; invocations ride the transport as correlated tool.calls.
  // Started before the ready signal so the socket exists by the time the
  // harness spawns the bridge.
  // send_file (Tier 3): reads the file HERE and streams it as file.part
  // frames; the correlated file.result comes back through the reader below.
  // Offered only when the runner said it can relay (config.outboundAttachments).
  const sendFile = createSendFileTools({
    homeDir: config.homeDir,
    send: (message) => transport.send(message),
  });

  // Sandbox ports (plans/sandbox-ports.md §7): streams dialed from inside the
  // guest on the runner's request, fenced by the pushed allowlist; discovery
  // reports what is listening so the UI can offer a share.
  const reservedPorts = reservedGuestPorts(process.env.OPEN_PROXY);
  const portStreams = createPortStreams({
    send: (message) => transport.send(message),
    reservedPorts,
  });
  // What a deployment's addon (addons.ts) may do to this supervisor.
  const addonHost: SupervisorAddonHost = {
    // Every conversation with a live turn, never "the one": `activeTurn`
    // answers null when two are in flight (its anchor rule).
    steerLiveTurns: (id, message) => {
      let steered = 0;
      for (const runtime of conversations.values()) {
        const turnId = runtime.activeTurnId;
        if (!turnId) continue;
        const steerId = id(turnId);
        if (runtime.steerInbox.some((entry) => entry.id === steerId)) continue;
        runtime.steerInbox.push({ targetTurnId: turnId, id: steerId, message });
        void steerFromInbox(runtime);
        steered += 1;
      }
      return steered;
    },
  };
  const sendAddonReport = () =>
    addon?.report?.((message) => transport.send(message));
  const portDiscovery = startPortDiscovery({
    send: (message) => transport.send(message),
    // An addon's own listeners are the platform's (never offered as a
    // share), like the open proxy: discovery must not list them.
    reservedPorts: new Set([...reservedPorts, ...(addon?.reservedPorts ?? [])]),
    onResend: sendAddonReport,
  });

  const platformTools = await startPlatformTools({
    // Resolved per bridge startup (jcode spawns a bridge per session), so a
    // session started after a mid-run presence change advertises the tools
    // that change brought — the doc and the tools move together.
    tools: () => [
      ...cronsTools,
      ...webhooksTools,
      ...memoryTools,
      // The messaging tools follow the channels section's condition: present
      // exactly when a LIVE presence exists — read from the SAME mutable
      // render inputs the home sync refreshes, never from boot config, so
      // the fragment and the tools can never disagree.
      ...channelsTools(renderInputs.channels),
      // message_agent follows the agents section's condition the same way.
      ...agentsTools(renderInputs.peers),
      // list_apps is unconditional: grants change independently of this
      // process, and the live tool is how a turn re-checks between syncs.
      ...connectionsTools,
      ...createProcessTools(processes),
      ...(config.previews ? previewsTools : []),
      ...(addon?.tools ?? []),
      ...(config.outboundAttachments ? sendFile.tools : []),
      // The skills tools follow their fragment's condition exactly: no
      // skillsDir, no skills capability — teaching and tools arrive together.
      ...(harness.capabilities.skillsDir ? skillsTools : []),
    ],
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

  /**
   * What the agent's surface looks like to a session: provider + status
   * per presence (handle/workspace are copy, not capability). Order-free.
   */
  const surfaceKey = (
    channels: readonly { provider: string; status: string }[],
  ): string =>
    channels
      .map((c) => `${c.provider}:${c.status}`)
      .sort()
      .join(",");
  // The peer roster is a surface too: message_agent appears with the first
  // peer and leaves with the last, and the doc names each one - a session
  // that captured the old list must restart to see the new one. The wire
  // carries names only (the exact word the tool takes), so a rename is a
  // roster change here.
  const peersKey = (peers: readonly { name: string }[]): string =>
    peers
      .map((p) => p.name)
      .sort()
      .join(",");
  // The connected-apps list is doc truth too: which apps, which accounts,
  // and above all which bound host each one works on.
  const connectionsKey = (
    connections: readonly AgentConnectionWire[],
  ): string =>
    connections
      .map((c) => `${c.provider}|${c.label ?? ""}|${c.host ?? ""}`)
      .sort()
      .join("\n");

  /**
   * Every live session captured a doc and a tool list that just went stale.
   * Flag them; `sessionFor` restarts each on its conversation's NEXT turn.
   * A conversation with a turn in flight keeps running — the flag is read
   * only at the next turn's start, so nothing in progress is disturbed.
   */
  const markSessionsStale = (reason: string, note: string | null): void => {
    let count = 0;
    for (const runtime of conversations.values()) {
      if (runtime.session) {
        runtime.surfaceStale = true;
        if (note) runtime.surfaceNote = note;
        count += 1;
      }
    }
    if (count > 0) {
      log("info", "live harness sessions marked stale", { reason, count });
    }
  };

  const runtimeFor = (conversationId: string): ConversationRuntime => {
    const existing = conversations.get(conversationId);
    if (existing) return existing;
    const created: ConversationRuntime = {
      queue: Promise.resolve(),
      pendingAborts: new Set(),
      steerInbox: [],
      steered: new Map(),
      steerDrain: Promise.resolve(),
      openTools: new Map(),
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
   *
   * A follow-up WITH files goes only once they are on disk, with its
   * inlineable images, packed like a turn's. Until then the drain stops at
   * it (anything sent after it waits behind it, order kept) and returns:
   * it never waits on a file write, so neither does a caller awaiting it
   * (the reader, with an abort behind it; the run's first event). The
   * files landing drains again.
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
        if (!entry || (entry.files && !entry.files.ready)) return;
        const images = collectInlineImages(entry.files?.manifest);
        try {
          await session.steer({
            id: entry.id,
            message: composePrompt(entry.message, entry.context),
            ...(images.length > 0 && { images }),
          });
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
    if (runtime.session && runtime.surfaceStale) {
      // The doc and tool list this session captured are out of date. Drop
      // it and start over on its own ref: resume keeps the transcript, and
      // jcode rebuilds the prompt and re-spawns the MCP bridge for the new
      // session (verified live: a fresh session sees the re-rendered doc and
      // the tools the bridge now advertises; a reused one does not).
      log("info", "harness session restarted: agent surface changed", {
        conversationId,
        sessionRef: runtime.session.sessionRef,
      });
      resumeSessionRef = runtime.session.sessionRef ?? resumeSessionRef;
      // Let the adapter drop its live hold on the ref first, or the resume
      // below would be refused as a duplicate and mint a memoryless session.
      await runtime.session.release?.();
      runtime.session = undefined;
      runtime.surfaceStale = false;
    }
    if (runtime.session) return runtime.session;
    // jcode lists this bridge's tools ASYNCHRONOUSLY after a session
    // starts, and serves its on-disk cache until that lands — so a turn
    // taken right after the start can advertise the PREVIOUS boot's tools.
    // That is what left `complete_task` reading as "unknown tool" for a
    // conversation resumed across the deploy that added it. Take the marker
    // BEFORE starting, so a listing that races us still counts.
    const waitForTools = harness.capabilities.platformTools;
    const listingMarker = waitForTools ? platformTools.listingMarker() : 0;
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
    // Hold the first turn until THIS session has taken its list from us.
    // Bounded: a harness that never asks proceeds anyway (see
    // `toolsListedSince`) — a stale tool list beats a stalled turn.
    if (waitForTools) {
      const listed = await platformTools.toolsListedSince(
        listingMarker,
        TOOL_LISTING_WAIT_MS,
      );
      if (!listed) {
        log("warn", "started a turn before the harness listed platform tools", {
          conversationId,
          waitedMs: TOOL_LISTING_WAIT_MS,
        });
      } else {
        // The listing is the REQUEST; jcode registers the answer into the
        // session just after it. Nothing on our side observes that last step
        // (the SDK has no MCP-ready event), so give it a brief, bounded
        // settle — measured live: 0ms still served the cached list, 500ms
        // already served the new one; 1s is margin on a once-per-session cost.
        await new Promise((resolve) =>
          setTimeout(resolve, TOOL_REGISTRATION_SETTLE_MS),
        );
      }
    }
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
     * one — `harness_busy` (the self-heal exhausting) or
     * `harness_no_terminal` (the post-accept deadline). */
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
     * `harness_busy` and `harness_no_terminal` come only from the terminal
     * error EVENT's code (the adapter mints them; the catch arm's raw throw
     * never does), and outrank the provider-refusal prose match. A rejected
     * transcript is checked before the refusal shapes too: its 400 must
     * never read as a key problem (#1194). A model-endpoint 404 comes last:
     * a 404 whose body also names a refusal (a quota page behind a proxy)
     * keeps the more actionable key copy.
     */
    const classify = (raw: string | undefined): string | undefined =>
      failureCode(runtime) ??
      (terminalErrorCode === TURN_FAILURE_CODES.harnessBusy ||
      terminalErrorCode === TURN_FAILURE_CODES.harnessNoTerminal
        ? terminalErrorCode
        : raw && isTranscriptRejected(raw)
          ? TURN_FAILURE_CODES.transcriptRejected
          : raw && isTrialCreditExhausted(raw)
            ? TURN_FAILURE_CODES.trialCreditExhausted
            : raw && isProviderRefusal(raw)
              ? TURN_FAILURE_CODES.modelProviderError
              : raw && isModelEndpointNotFound(raw)
                ? TURN_FAILURE_CODES.modelEndpointNotFound
                : undefined);

    /**
     * Which of the agent's words this turn keeps as its answer (answer.ts:
     * what it said after its last tool call, message by message). Mid-turn
     * narration still streams to every live tail; only the closing words are
     * what the transcript keeps and the channel posts.
     */
    const answer = createAnswerTracker();
    let answerSent = false;
    /** Store a follow-up's reply under its own row, bounded like the answer. */
    const emitReply = (followUpId: string, reply: string) => {
      transport.send({
        kind: "event",
        turnId: followUpId,
        conversationId: item.conversationId,
        event: { type: "text", text: reply.slice(0, MAX_ANSWER_CHARS) },
      });
    };
    /**
     * Send the answer exactly once, whatever ends the turn — cleanly, with an
     * error, by abort, or by the stream simply stopping. A partial answer is
     * still what the user watched arrive, so it is still what the transcript
     * owes them.
     */
    const emitAnswer = () => {
      if (answerSent) return;
      const text = answer.answer();
      if (!text) return;
      answerSent = true;
      transport.send({
        kind: "event",
        turnId: item.turnId,
        conversationId: item.conversationId,
        event: { type: "text", text },
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
    const beat = () =>
      transport.send({
        kind: "progress",
        turnId: item.turnId,
        conversationId: item.conversationId,
      });
    const progressTimer = setInterval(
      beat,
      config.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
    );
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
      // HERE, at the harness boundary (`composePrompt`). The EMPTY-PROMPT
      // GUARD is load-bearing, not cosmetic: a file-only message on a path
      // with no context (a runner without the attachments capability, a
      // failed context build) would otherwise hand the harness an empty
      // string, which jcode turns into an empty text block the model API
      // rejects with a 400 (verified in v0.71.1; v0.81.1 still passes the
      // content through verbatim, no filtering).
      const surfaceNote = runtime.surfaceNote;
      runtime.surfaceNote = undefined;
      const context = [surfaceNote, item.context]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      const composed = composePrompt(item.message, context);
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
        // run. Only ids this supervisor actually delivered are honored: an
        // adapter cannot mint outcomes for messages it was never handed.
        if (
          event.type === "message.joined" &&
          runtime.steered.has(event.followUpId)
        ) {
          runtime.steered.set(event.followUpId, true);
        }
        // What the agent said back to a joined follow-up becomes that
        // follow-up's OWN answer, stored under its row so the reply sits
        // under the message it answers. Claimed out of the turn's answer
        // first, so the words are kept once; the turn's closing words are
        // never taken. The reply arrives LIVE, so a reply that is
        // the answer's only words right now is held by the tracker and
        // handed over below, at the first event showing the agent went on
        // to say more. Honored under the same fence as the join. The
        // platform's own steer (the ceiling warning) has no row to store it
        // under: what the agent says back to it is the turn's wrap-up, and
        // stays the turn's answer.
        if (
          event.type === "message.replied" &&
          runtime.steered.get(event.followUpId) === true &&
          !isPlatformSteerId(event.followUpId) &&
          answer.claim(event.followUpId, event.reply)
        ) {
          emitReply(event.followUpId, event.reply);
        }

        // The answer is built from the harness's own events, framing
        // included. The deltas themselves are ephemeral by design (the
        // delta law), and this supervisor is the only party that sees the
        // whole stream, so if it does not keep the closing words, nothing
        // can.
        for (const handed of answer.observe(event)) {
          emitReply(handed.followUpId, handed.reply);
        }

        if (event.type === "tool.started" || event.type === "tool.finished") {
          const bare = bareToolName(event.name);
          const open = runtime.openTools.get(bare) ?? 0;
          if (event.type === "tool.started") {
            runtime.openTools.set(bare, open + 1);
          } else if (open <= 1) {
            runtime.openTools.delete(bare);
          } else {
            runtime.openTools.set(bare, open - 1);
          }
        }

        // The answer goes out BEFORE the terminal event, not after: `seq` is
        // assigned in arrival order, so emitting it afterwards would place the
        // reply below the marker that says the turn ended.
        if (isTerminalEvent(event)) emitAnswer();

        // Framing stops here (answer.ts): a correction has no wire form, and
        // a delta travels without its message id. A delta that is the reply
        // to a steered follow-up travels under THAT follow-up's id, so the
        // reply streams under the message it answers (the durable `text`
        // the handover stores there replaces it). Under the same fence as
        // the join: only a follow-up this supervisor delivered and saw
        // joined re-keys a delta (an adapter cannot stream under a row it
        // was never handed). The platform's own steer has no row, so its
        // reply stays under the turn.
        const wire = toWireEvent(event);
        if (wire) {
          const replyTarget = replyTargetOf(event);
          transport.send({
            kind: "event",
            turnId:
              replyTarget !== undefined &&
              runtime.steered.get(replyTarget) === true
                ? replyTarget
                : item.turnId,
            conversationId: item.conversationId,
            event: wire,
          });
        }
        // The FIRST beat goes out right behind `turn.started`, not an
        // interval later: the stall sweep only covers a turn that has beaten
        // at least once, so a turn shorter than one interval whose
        // `turn.finished` was then lost waited out the whole turn ceiling.
        // Behind it, never before it: the control plane stamps only a
        // RUNNING turn, and `turn.started` is what makes it running.
        if (event.type === "turn.started") beat();
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
        // Preserve terminal errors on coded and uncoded failures alike.
        // Known codes map to canonical copy in the control plane. Uncoded
        // failures keep this raw detail instead of closing with a NULL error.
        // Bound at the sender: an oversized terminal frame would be dropped.
        ...(status === "failed" &&
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
      runtime.openTools.clear();
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
   * SEND NOW: the person asked the run to read a waiting
   * follow-up NOW rather than after the tool it is waiting on. Moves that
   * tool to the background (it keeps running; the model is told where to
   * collect it), so the run reaches its next safe point and the queued
   * message is injected within moments.
   *
   * The answer goes back under the FOLLOW-UP's own id as
   * `message.sent_now`, and it is only ever what happened:
   *
   * - the run ended, or this is not its run: silence. Nothing is waiting
   *   any more; the row's own status tells the rest.
   * - the message was already read (joined): silence, for the same reason.
   * - the message never reached this run (a refused steer, an inbox that
   *   was full): `moved: false`, so the person is not left waiting on a
   *   request nothing can serve. It is read at the next safe point, or runs
   *   as the next turn.
   * - delivered and waiting: the harness moves the tool, and says whether
   *   it did.
   *
   * A steer delivery still in flight is awaited first: the control plane
   * may hand over the delivery and this request in one batch, and the
   * request must see the delivery's outcome rather than race it.
   */
  const sendNow = async (item: {
    turnId: string;
    targetTurnId: string;
    conversationId: string;
  }) => {
    const runtime = conversations.get(item.conversationId);
    if (runtime) {
      // The steer it asks about may still be waiting on its files; its
      // landing drains, and this waits for that drain (registered first).
      await runtime.steerInbox.find((entry) => entry.id === item.turnId)?.files
        ?.landed;
      await runtime.steerDrain;
    }
    if (
      !runtime ||
      runtime.activeTurnId !== item.targetTurnId ||
      runtime.steered.get(item.turnId) === true
    ) {
      log("info", "send now for a message nothing is waiting on", {
        conversationId: item.conversationId,
        turnId: item.turnId,
      });
      return;
    }
    const session = runtime.session;
    const moved: BackgroundedTool =
      runtime.steered.has(item.turnId) &&
      runtime.streamStarted &&
      harness.capabilities.backgroundTool &&
      session?.backgroundRunningTool
        ? await session.backgroundRunningTool()
        : { moved: false };
    log("info", "send now", {
      conversationId: item.conversationId,
      turnId: item.turnId,
      moved: moved.moved,
    });
    transport.send({
      kind: "event",
      turnId: item.turnId,
      conversationId: item.conversationId,
      event: {
        type: "message.sent_now",
        moved: moved.moved,
        ...(moved.moved && moved.toolName && { toolName: moved.toolName }),
      },
    });
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
  // An addon's report, once at ready (then on the re-send beat), so the
  // control plane hears it before anything reads it.
  sendAddonReport();

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

      if (isPortWorkItem(item)) {
        // Sandbox ports (plans/sandbox-ports.md §7): byte streams must never
        // queue behind a running turn (a preview would hang for its whole
        // duration), and the handler never awaits — it is a socket pump.
        portStreams.handle(item);
        continue;
      }

      if (item.kind === "desktop.control") {
        // Inline like the port pump and the steer: queued behind a running
        // turn it would land after that turn ended. The addon that knows
        // the kind handles it; without one the frame is inert.
        addon?.handle?.(item, addonHost);
        continue;
      }

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
        const entry: SteerInboxEntry = {
          targetTurnId: item.targetTurnId,
          id: item.turnId,
          message: item.message,
          ...(item.context && { context: item.context }),
        };
        if (item.attachments?.length) {
          // Its parts came ahead of this frame and are on the sync chain
          // right now: it lands with them, and the landing drains again.
          const files: NonNullable<SteerInboxEntry["files"]> = {
            manifest: item.attachments,
            ready: false,
            landed: syncQueue.then(() => {
              files.ready = true;
            }),
          };
          entry.files = files;
          void files.landed.then(() => steerFromInbox(runtime));
        }
        runtime.steerInbox.push(entry);
        if (runtime.activeTurnId === item.targetTurnId) {
          await steerFromInbox(runtime).catch((error: unknown) =>
            log("warn", "steer failed", { error: String(error) }),
          );
        }
        continue;
      }

      if (item.kind === "turn.send_now") {
        // Inline like abort and steer: queued behind the turn it should
        // interrupt, it would arrive after the tool it means to cut short.
        // Not awaited: it waits for the steer it asks about to be handed
        // over, files included, and the reader must stay free for an abort.
        void sendNow(item).catch((error: unknown) =>
          log("warn", "send now failed", { error: String(error) }),
        );
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

      if (item.kind === "file.result") {
        // Inline like tool.result: a send_file call inside the running turn
        // is awaiting exactly this; queued behind that turn it would deadlock
        // into the tool's timeout.
        sendFile.handleResult(item);
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
          .then(async () => {
            if (poisonedSyncGeneration === item.generation) return;
            const before = surfaceKey(renderInputs.channels);
            const beforePresences = [...renderInputs.channels];
            const beforePeers = peersKey(renderInputs.peers);
            const beforeConnections = connectionsKey(renderInputs.connections);
            const beforeConnectionList = [...renderInputs.connections];
            await applySync(
              config.homeDir,
              item,
              renderInputs,
              (message) => transport.send(message),
              harvester,
            );
            if (surfaceKey(renderInputs.channels) !== before) {
              markSessionsStale(
                "channels changed",
                channelsChangeNote(beforePresences, renderInputs.channels),
              );
            } else if (peersKey(renderInputs.peers) !== beforePeers) {
              // No conversation note: nothing here misleads a session the
              // way a removed-then-restored app did; the re-rendered doc
              // and tool list are the whole change.
              markSessionsStale("peers changed", null);
            } else if (
              connectionsKey(renderInputs.connections) !== beforeConnections
            ) {
              // A live session read the old connected-apps list (or an old
              // bound host) — restart it so it calls the right place.
              // The note is the transcript half: a restarted session still
              // reads its own earlier "X isn't connected" turns, and a
              // re-rendered doc loses to them (the Granola incident).
              markSessionsStale(
                "connections changed",
                connectionsChangeNote(
                  beforeConnectionList,
                  renderInputs.connections,
                ),
              );
            }
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
      // compiling into this branch and being run as a turn. (The transport
      // type already excludes the WS driver's own `session`/`ack` items.)
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
    // Pending send_file waits resolve as timeouts for the same reason.
    sendFile.close();
    // Preview streams and discovery: abort every open stream (the runner
    // tears its halves down on the channel close anyway) and stop polling.
    portDiscovery.stop();
    portStreams.close();
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
