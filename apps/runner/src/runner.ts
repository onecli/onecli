import { createHash } from "node:crypto";
import {
  MAX_SANDBOX_CHECK_IDS,
  SESSION_RESUME_GRACE_MS,
  TURN_FAILURE_CODES,
  type AttachmentManifestEntry,
  type RunnerCapabilities,
  type RunnerEvent,
  type RunnerSandboxesResponse,
  type RunnerWorkItem,
  type SandboxStartFailureReason,
  type SandboxStartPayload,
} from "@onecli/agent-protocol";
import type { RunnerConfig } from "./config";
import { installationFingerprint } from "./installation";
import { attachmentPartFrames, verifyPulledAttachment } from "./attachments";
import { ControlPlaneError, type ControlPlaneClient } from "./control-plane";
import {
  ImageUnavailableError,
  SandboxCapacityError,
  type SandboxBackend,
  type SandboxSnapshot,
} from "./backend/types";
import { createKeyedChains, createSemaphore } from "./executor";
import { classifySandbox, vanishedSandboxes } from "./reconcile-classify";
import {
  hashBootstrapToken,
  mintBootstrapToken,
  type RunnerWsServer,
  type SupervisorConnection,
} from "./ws/server";
import { log } from "./log";

/**
 * The runner loop (plans/hosted-agents-v2.md step 3).
 *
 * Three behaviors, in order of importance:
 *
 * 1. **Poll is the clock** (§3.3). There is no scheduler anywhere; the runner
 *    long-polls, executes what it is given, and reports back.
 * 2. **Reconcile is the truth** (and the teardown path). What the control
 *    plane says this runner should host is authoritative; anything labeled as
 *    ours and absent from that list is destroyed — container and volume. This
 *    is how deleting an agent reaches the compute plane, and it is crash-safe
 *    by construction: a runner that died mid-delete cleans up on next boot.
 * 3. **Starts are idempotent.** A start for a sandbox whose payload hash is
 *    unchanged just starts the existing container; a changed payload (a
 *    regenerated token) recreates it. Both paths converge on "the container
 *    matches the payload the control plane last handed us".
 */

/** How long a work poll asks the server to hold. */
const POLL_WAIT_SECONDS = 25;
const POLL_LIMIT = 5;
const HEARTBEAT_MS = 30_000;
/** Backoff bounds when the control plane is unreachable. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/**
 * Cadence of the `starting` progress heartbeat a claimed start emits from the
 * moment it is ENQUEUED until it settles. The control plane's
 * stale-claim window is 300s measured on the row's update clock; a start
 * queued behind the lifecycle semaphore (or executing a minutes-long wake)
 * emits no ordinary events in that window, and without the heartbeat the
 * claim goes stale and the same start is re-dispatched mid-flight.
 */
const START_HEARTBEAT_MS = 120_000;
/**
 * How long after its spawn is recorded a dead, never-connected container
 * waits before it is a boot crash. Generous against a slow supervisor boot:
 * misclassifying a healthy boot parks the whole turn queue 150s later,
 * while a real crash only waits this long once.
 */
const BOOT_DIAL_IN_GRACE_MS = 180_000;
/**
 * How long the reconciler waits for a sandbox whose holder copy died (or
 * whose channel predates channel records) to reconnect before treating its
 * silence as death. Much shorter than the supervisor's whole retry budget
 * (`SESSION_RESUME_GRACE_MS`, ~15.5 min, the grace for a drop a live copy
 * saw): a session-holding supervisor redials within a second of losing its
 * copy and keeps retrying every <=15 s, so it is back as soon as any copy
 * is reachable. 3 min leaves a wide margin over a normal reconnect.
 */
const INHERITED_RESUME_GRACE_MS = 180_000;

/**
 * How a closed channel's container is looked at: this many looks, this far
 * apart. A SIGKILL'd container reads `running` for ~100 ms after its socket
 * closes; 5 looks over ~2 s cover any substrate's lag without letting a
 * live, reconnecting supervisor's container cost more than a few reads.
 */
const CLOSED_CHANNEL_LOOKS = 5;
const CLOSED_CHANNEL_LOOK_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Identifies a spawn payload — recorded as a container label so an operator
 * (and any future differ) can tell at a glance whether a running sandbox was
 * built from the credentials the control plane holds now.
 *
 * It is deliberately NOT used to skip recreation: the control channel's
 * bootstrap token is single-use, so every start replaces the container.
 */
export const payloadHash = (payload: SandboxStartPayload): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        env: Object.entries(payload.env).sort(),
        // Paths and modes only — NOT contents. A credential stub carries a
        // freshly-stamped timestamp on every build (it must look recently
        // refreshed to the tool that reads it), so hashing its bytes would
        // make the payload look changed on every dispatch. Real credential
        // changes still move the hash: they change `env`.
        files: payload.files
          .map((file) => [file.containerPath, file.mode ?? null])
          .sort(),
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        harness: payload.harness ?? null,
        instructions: payload.instructions ?? null,
        channels: payload.channels ?? null,
      }),
    )
    .digest("hex");

/**
 * Loopback is never egress. Without it in NO_PROXY, an agent's own
 * `curl http://localhost:8080` (checking the service it just started) is
 * sent to the gateway and comes back empty (observed live: the gateway
 * logged every such call as `HTTP_PROXY host=localhost`). Exempting it
 * moves nothing off the fence: loopback stays inside the guest.
 */
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];

/**
 * Keep the sandbox's control channel OFF the proxy.
 *
 * The bootstrap payload sets `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` so that
 * every byte the agent sends goes through the gateway — which is the product.
 * But the supervisor's own socket to its runner is host-local infrastructure,
 * not agent egress: proxying it sends a WebSocket upgrade for an internal host
 * to the gateway, and the channel simply never opens (observed live).
 *
 * §3.4 names two legal destinations from a sandbox — the gateway and its
 * runner — so exempting the runner is the rule, not a hole in it. The network
 * remains the enforcement: everything else still has nowhere to go.
 *
 * `loopback` adds LOOPBACK_NO_PROXY as well; only a harness that routes
 * loopback THROUGH the gateway on purpose turns it off.
 */
export const noProxyForRunner = (
  advertisedHost: string,
  payloadEnv: Record<string, string>,
  loopback = true,
): Record<string, string> => {
  const existing = payloadEnv.NO_PROXY ?? payloadEnv.no_proxy ?? "";
  const hosts = existing
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const h of [advertisedHost, ...(loopback ? LOOPBACK_NO_PROXY : [])]) {
    if (!hosts.includes(h)) hosts.push(h);
  }
  const value = hosts.join(",");
  // Both spellings: tools differ on which they read.
  return { NO_PROXY: value, no_proxy: value };
};

export interface RunnerDeps {
  config: RunnerConfig;
  backend: SandboxBackend;
  controlPlane: ControlPlaneClient;
  wsServer: RunnerWsServer;
  /** Cadence overrides — tests only (the ws server's pingIntervalMs
   * precedent); production uses the module constants. */
  startHeartbeatMs?: number;
  bootDialInGraceMs?: number;
  /**
   * How long the reconciler waits for a sandbox whose holder copy died to
   * reconnect before treating its silence as death. Tests only; production
   * uses `INHERITED_RESUME_GRACE_MS`.
   */
  inheritedResumeGraceMs?: number;
  /** The interval between looks at a closed channel's container. Tests
   * only; production uses `CLOSED_CHANNEL_LOOK_MS`. */
  closedChannelLookMs?: number;
}

type StartItem = Extract<RunnerWorkItem, { kind: "sandbox.start" }>;
type StopItem = Extract<RunnerWorkItem, { kind: "sandbox.stop" }>;

export interface Runner {
  /** Register + prepare the backend. Returns the assigned runner id. */
  start(): Promise<string>;
  /** One poll→execute cycle. Exposed so tests drive it deterministically. */
  tick(wait?: number): Promise<void>;
  /** One reconcile pass against the control plane's sandbox list. */
  reconcile(): Promise<void>;
  /**
   * Resolves once every enqueued work item and every queued report has
   * settled. `tick` only ENQUEUES — this is the deterministic drain
   * tests (and the shutdown path) wait on.
   */
  settle(): Promise<void>;
  /** The long-running loop: poll forever until `stop()`. */
  run(): Promise<void>;
  /**
   * Leave gracefully: stop polling, retire this copy's identity (it is
   * handed nothing new, and its sandboxes and the reconciler role pass on
   * at once), hand every supervisor socket over to another copy (`drain`),
   * and run whatever the poll in flight brings back. Sandboxes are left
   * running.
   */
  stop(): Promise<void>;
}

/** Ceiling on the registration backoff — long enough to stop log spam, short
 *  enough that a control plane coming up is picked straight back up. */
const REGISTER_RETRY_CAP_MS = 10_000;

/**
 * A status the register loop should wait out rather than die on. Register is
 * idempotent server-side (a known token updates its row), so retrying an
 * ambiguous failure is always safe — the only question is whether the answer
 * is a durable verdict about THIS runner's config:
 *
 * - 401 (and other 4xx like 400/404): the control plane heard us and refused
 *   — a wrong or missing `RUNNER_TOKEN`, a wrong URL. Retrying hides a
 *   misconfiguration; exit saying so.
 * - 403/429: a middlebox (a WAF, a fronting proxy) blocked or throttled the
 *   request before the origin ever saw it — the register surface itself never
 *   answers either. Dying here turned transient infrastructure noise into a
 *   crash loop the noise then kept down.
 * - any 5xx: the control plane (or something in front of it) is unhealthy —
 *   a deploy window, an overloaded origin. Exactly the "not up yet" case the
 *   loop exists for.
 */
const transientRegisterStatus = (status: number): boolean =>
  status === 403 || status === 429 || status >= 500;

/**
 * Register, waiting out a control plane that is not up yet — or not
 * reachable in a healthy state yet.
 *
 * The runner and the api start together — compose gates it with
 * `depends_on: service_healthy`, `pnpm dev` gates it with nothing — and the
 * runner reliably wins that race by a few hundred milliseconds. Exiting there
 * meant one crashed process took the whole dev session down, because a task
 * runner stops every task when one fails.
 *
 * Transport failures wait, and so do answered-but-transient statuses per
 * `transientRegisterStatus` above. A control plane that ANSWERS with a
 * durable refusal — a wrong or missing `RUNNER_TOKEN`, which comes back
 * 401 — is a misconfiguration that retrying would hide, so it still throws
 * and the process still exits saying so.
 *
 * Wrapped around the REGISTER call alone, not around `start()`: `start()` also
 * binds the control-channel socket, and retrying that raises
 * ERR_SERVER_ALREADY_LISTEN forever instead of recovering.
 */
const registerWithRetry = async (
  controlPlane: ControlPlaneClient,
  controlPlaneUrl: string,
  registration: Parameters<ControlPlaneClient["register"]>[0],
): Promise<{ runnerId: string; replicaId: string }> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await controlPlane.register(registration);
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        !transientRegisterStatus(error.status)
      ) {
        throw error;
      }
      const waitMs = Math.min(2 ** (attempt - 1) * 500, REGISTER_RETRY_CAP_MS);
      // The URL and the error, because "still booting" and "you typo'd
      // RUNNER_CONTROL_PLANE_URL" otherwise print the same line forever (a
      // ControlPlaneError's String carries its status, so an answered-but-
      // transient refusal is distinguishable here too). Past a minute of
      // this it is no longer a startup race, so say so louder.
      log(
        attempt > 10 ? "error" : "warn",
        "control plane unavailable; waiting to register",
        {
          attempt,
          waitMs,
          url: controlPlaneUrl,
          error: String(error),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
};

export const createRunner = ({
  config,
  backend,
  controlPlane,
  wsServer,
  startHeartbeatMs = START_HEARTBEAT_MS,
  bootDialInGraceMs = BOOT_DIAL_IN_GRACE_MS,
  inheritedResumeGraceMs = INHERITED_RESUME_GRACE_MS,
  closedChannelLookMs = CLOSED_CHANNEL_LOOK_MS,
}: RunnerDeps): Runner => {
  let running = false;
  /** Set the moment `stop` begins: the sockets that close from then on are
   * this copy's own drain, not containers dying. */
  let stopping = false;
  /** The poll loop, while `run` drives it: `stop` waits for its last poll. */
  let loop: Promise<void> = Promise.resolve();
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;

  /**
   * THE LIFECYCLE EXECUTOR. Every work item runs on its sandbox's
   * FIFO chain — which is where all the per-sandbox ordering guarantees live
   * (sync frames before the turn frame, deliver before steer, a start before
   * anything dispatched after it). Only STARTS additionally take the global
   * semaphore: they are the expensive backend operations (a cloud wake can
   * legitimately hold for minutes), and at `lifecycleConcurrency: 1` the
   * semaphore reproduces the old serial tick for backend work. Stops are
   * deliberately exempt — they are cheap everywhere (cloud park is accepted,
   * never awaited), and a stop queued past the control plane's 300s
   * stale-claim window would be re-dispatched as a spurious START.
   */
  const chains = createKeyedChains((sandboxId, error) => {
    log("warn", "work item failed", { sandboxId, error: String(error) });
  });
  const startSlots = createSemaphore(config.lifecycleConcurrency);

  /**
   * Reports ride ONE ordered chain. Item reports were ordered by the serial
   * tick before; now that items settle concurrently, the chain keeps their
   * arrival order deterministic — and it is what makes the heartbeat safe:
   * a final status is enqueued only after its heartbeat interval is cleared,
   * so no `starting` can land after the settlement it belongs to. (`report`
   * never rejects — it logs — so the chain cannot wedge.)
   */
  let reportChain: Promise<void> = Promise.resolve();
  const enqueueReport = (events: RunnerEvent[]): Promise<void> => {
    if (events.length === 0) return reportChain;
    const next = reportChain.then(() => report(events));
    reportChain = next;
    return next;
  };

  /** sandboxId → the queued (not yet executing) start/stop, replaceable in
   * place: a re-dispatched twin SUPERSEDES the queued payload (dispatch
   * composes from current truth — absorbing would discard rotated
   * credentials), and one settlement report satisfies both claims. */
  const queuedStarts = new Map<string, { item: StartItem }>();
  const queuedStops = new Map<string, { item: StopItem }>();
  /** sandboxId → this copy's starts and stops for it, from enqueue until
   * each has reported. A start and a stop can both be in flight (a start
   * queued behind an executing stop), hence a count. Either one closes the
   * container's socket and speaks for the sandbox itself. */
  const lifecycleInFlight = new Map<string, number>();
  const beginLifecycle = (sandboxId: string): void => {
    lifecycleInFlight.set(
      sandboxId,
      (lifecycleInFlight.get(sandboxId) ?? 0) + 1,
    );
  };
  const endLifecycle = (sandboxId: string): void => {
    const left = (lifecycleInFlight.get(sandboxId) ?? 1) - 1;
    if (left > 0) lifecycleInFlight.set(sandboxId, left);
    else lifecycleInFlight.delete(sandboxId);
  };
  /** sandboxId → payload hash of the start EXECUTING right now. A twin with
   * the same hash is absorbed (recreating an identical container buys
   * nothing); a differing hash queues — the recreate is then correct. */
  const executingStartHash = new Map<string, string>();
  const startHeartbeats = new Map<string, NodeJS.Timeout>();
  /**
   * Fresh creates admitted past the capacity check but not yet visibly
   * `running` (a remote sandbox can boot for minutes; a booting sibling is invisible
   * to the live count). Without this, N concurrent starts all read the same
   * stale count and all pass at capacity − 1. Entries are pruned inside the
   * check itself: an id now running (or gone — a failed create) drops out.
   */
  const admittedNew = new Set<string>();

  const stopStartHeartbeat = (sandboxId: string): void => {
    const timer = startHeartbeats.get(sandboxId);
    if (timer) clearInterval(timer);
    startHeartbeats.delete(sandboxId);
  };

  const beginStartHeartbeat = (sandboxId: string): void => {
    stopStartHeartbeat(sandboxId);
    const timer = setInterval(() => {
      // Ref-less on purpose: refs land with the real progress events; the
      // heartbeat only refreshes the row's update clock. Residual: an
      // interval firing in the same macrotask as settlement is impossible
      // (clear + final enqueue are synchronous), and a heartbeat REPORT in
      // flight at settlement is ordered before the final by the report
      // chain — the one unfixable race (a post lost to the network landing
      // late) is bounded and self-heals via idle-stop.
      void enqueueReport([
        { kind: "sandbox.status", sandboxId, status: "starting" },
      ]);
    }, startHeartbeatMs);
    timer.unref?.();
    startHeartbeats.set(sandboxId, timer);
  };

  const capabilities = (): RunnerCapabilities => ({
    maxSandboxes: config.maxSandboxes,
    backend: backend.id,
    homeDurability: backend.homeDurability,
    // This build parses `turn.message` — the control plane's steer arm is
    // gated on the advertisement, because an unknown work kind would poison
    // a whole poll batch on a runner that predates it.
    steerMessages: true,
    // This build forwards `turn.send_now`. Gated like the
    // steer arm, for the same reason: an unknown kind poisons a batch.
    sendNow: true,
    // This build pulls attachment bytes and streams them ahead of the turn.
    // Dispatch composes the manifest + context note only when this is
    // advertised, so an older runner's turns simply ship bare.
    attachments: true,
    // And ahead of a mid-run follow-up's `turn.message` the same way: the
    // steer arm hands a follow-up with files only to a runner saying so.
    steerAttachments: true,
    // This build forwards `desktop.control` to the supervisor and relays
    // its `desktop.state`. The claim arm is gated on it, so an older runner
    // never meets the kind.
    desktopControl: true,
    // This build reassembles `file.part` runs and relays them to
    // POST /v1/runner/attachments (send_file). The control plane hands the
    // supervisor the tool only when its runner advertises this, so an agent
    // is never offered a send_file that cannot land.
    outboundAttachments: true,
  });

  const report = async (events: RunnerEvent[]): Promise<void> => {
    try {
      await controlPlane.postEvents(events);
    } catch (error) {
      // Events are advisory: the control plane's stale-claim window recovers a
      // sandbox whose status never arrived, so a failed report must not take
      // the runner down.
      log("warn", "failed to report events", { error: String(error) });
    }
  };

  /** Stop and remove one container, logging rather than throwing: the
   * cleanup arms (a stood-down start, a boot-crash corpse) must never fail
   * the path that called them. */
  const removeQuietly = async (
    containerRef: string,
    sandboxId: string,
  ): Promise<void> => {
    try {
      await backend.stopSandbox(containerRef, sandboxId);
      await backend.removeSandbox(containerRef, sandboxId);
    } catch (error) {
      log("warn", "failed to remove a container", {
        sandboxId,
        error: String(error),
      });
    }
  };

  const startSandbox = async (item: StartItem): Promise<RunnerEvent[]> => {
    const hash = payloadHash(item.payload);
    // Built incrementally so the catch appends `failed` after whatever
    // progress was already reported — and EVERYTHING that can touch the
    // daemon runs inside the try. The first list and the home provisioning
    // used to sit outside it: a daemon dead exactly there threw out of the
    // whole tick, reported nothing, and left the sandbox `starting` until
    // the 300s stale claim instead of `failed` with a reason.
    const events: RunnerEvent[] = [];

    try {
      const snapshots = await backend.listSandboxes();
      const existing = snapshots.find(
        (snapshot) => snapshot.sandboxId === item.sandboxId,
      );

      // Capacity is enforced here as well as at placement: the runner is the
      // only party that knows what it is actually holding right now. The
      // admitted set covers what the live count cannot see — fresh creates
      // still booting (not `running`) or executing in a concurrent slot.
      // The prune + check + add below run synchronously off ONE awaited
      // snapshot, so concurrent starts interleave only between awaits and
      // each sees the earlier one's admission.
      if (!existing) {
        for (const id of admittedNew) {
          // An id still queued/executing may legitimately be absent from the
          // snapshot (its create call is in flight) — never prune those.
          if (queuedStarts.has(id) || executingStartHash.has(id)) continue;
          const seen = snapshots.find((s) => s.sandboxId === id);
          if (!seen || seen.running) admittedNew.delete(id);
        }
        const live = snapshots.filter((snapshot) => snapshot.running).length;
        if (live + admittedNew.size >= config.maxSandboxes) {
          events.push({
            kind: "sandbox.status",
            sandboxId: item.sandboxId,
            status: "failed",
            error: `runner at capacity (${config.maxSandboxes} sandboxes)`,
            // `satisfies` binds the literal to the shared vocabulary — the
            // wire field is an open string, so a typo here would otherwise
            // compile clean and silently degrade to the generic copy.
            reasonCode: "at_capacity" satisfies SandboxStartFailureReason,
          });
          return events;
        }
        admittedNew.add(item.sandboxId);
      }

      const homeRef = await backend.provisionHome(item.sandboxId);

      events.push({
        kind: "sandbox.status",
        sandboxId: item.sandboxId,
        status: "starting",
        homeRef,
      });

      // Recreate on ANY start of an existing container, not only when the
      // payload changed. The control-channel bootstrap token is single-use and
      // baked into the container's environment, so a container that has
      // already connected once can never authenticate again — starting it
      // instead of replacing it produces a sandbox that runs but can never
      // report, and the control plane re-dispatches it forever. Recreating is
      // cheap (the durable home volume is untouched) and it is the only
      // way the woken sandbox gets a live credential.
      if (existing) {
        await backend.stopSandbox(existing.containerRef, item.sandboxId);
        await backend.removeSandbox(existing.containerRef, item.sandboxId);
      }

      // The workspace is the wake's placement for a home it has to BIRTH
      // (a brand-new agent on a snapshot backend: disk and device come up
      // before the sandbox exists); an existing home ignores it.
      await backend.wakeHome(homeRef, item.payload.workspaceId);
      // Minted here and never kept: the control plane holds only its hash,
      // so whichever copy the supervisor reaches can admit it, once.
      const bootstrapToken = mintBootstrapToken();
      const containerRef = await backend.createSandbox({
        sandboxId: item.sandboxId,
        ...(item.payload.workspaceId && {
          workspaceId: item.payload.workspaceId,
        }),
        image: config.agentImage,
        env: {
          ...item.payload.env,
          ...noProxyForRunner(
            config.advertisedHost,
            item.payload.env,
            config.noProxyLoopback,
          ),
          ...(item.payload.model && { AGENT_MODEL: item.payload.model }),
          ...(item.payload.effort && { AGENT_EFFORT: item.payload.effort }),
          ...(item.payload.harness && {
            AGENT_HARNESS: item.payload.harness,
          }),
          ...(item.payload.instructions && {
            AGENT_INSTRUCTIONS: item.payload.instructions,
          }),
          ...(item.payload.agentName && {
            AGENT_NAME: item.payload.agentName,
          }),
          // The channels section's boot input (the supervisor parses it with
          // the wire schema). Sent only when the control plane composed one;
          // absent reads as "no presences" there.
          ...(item.payload.channels && {
            AGENT_CHANNELS: JSON.stringify(item.payload.channels),
          }),
          // The `agents` capability's roster (PR 5b), same rule.
          ...(item.payload.peers && {
            AGENT_PEERS: JSON.stringify(item.payload.peers),
          }),
          // The `connections` capability's attached-apps list, same rule.
          ...(item.payload.connections && {
            AGENT_CONNECTIONS: JSON.stringify(item.payload.connections),
          }),
          // The preview apps to bring back on this boot (only on a wake a
          // preview hit caused — the control plane composes it then and
          // only then), same rule.
          ...(item.payload.previewRelaunch && {
            AGENT_PREVIEW_RELAUNCH: JSON.stringify(
              item.payload.previewRelaunch,
            ),
          }),
          SANDBOX_ID: item.sandboxId,
          RUNNER_WS_URL: `ws://${config.advertisedHost}:${config.advertisedPort}`,
          SANDBOX_WS_TOKEN: bootstrapToken,
          // The supervisor offers send_file only when THIS runner can
          // relay the bytes (capabilities.outboundAttachments) — a runner
          // that predates the frame would drop it on validation and the
          // model would wait out a timeout for a file that never left.
          RUNNER_OUTBOUND_ATTACHMENTS: "1",
          // Same rule for previews: preview_expose (and the fragment that
          // teaches it) only where this runner can carry port streams, i.e.
          // its port API is configured. Otherwise the agent would be taught
          // a tool whose every call fails.
          ...(config.portApi && { RUNNER_PORT_STREAMS: "1" }),
          // The hosted platform's agent desktop: only on the hosted
          // backend, and only where the screen can be carried (port
          // streams). Every other runner leaves the plain desktop alone.
          ...(config.backend === "cloud" &&
            config.portApi && { RUNNER_HOSTED_DESKTOP: "1" }),
        },
        files: item.payload.files,
        homeRef,
        limits: config.limits,
        payloadHash: hash,
        resumable: wsServer.resumable,
      });

      // Record the spawn BEFORE start: from here on any copy can admit its
      // supervisor's first connect (the control plane matches the token's
      // hash and names this container). On Docker the create returns before
      // the container runs, so the record always lands first. On a
      // substrate whose create returns once the sandbox runs, a supervisor
      // that dialled in earlier was refused and redials within seconds.
      //
      // Refused means this start no longer applies: the sandbox moved on
      // (deleted, respawned) or another copy owns its lifecycle now. Stand
      // down and remove what was just created; nothing is reported, since
      // the row is someone else's business. (Its capacity admission frees
      // itself: the next check prunes an admitted id with no container.)
      const recorded = await controlPlane
        .recordSpawn(item.sandboxId, {
          containerRef,
          tokenHash: hashBootstrapToken(bootstrapToken),
        })
        .catch(async (error: unknown) => {
          await removeQuietly(containerRef, item.sandboxId);
          throw error;
        });
      if (!recorded) {
        log("info", "start no longer applies; standing down", {
          sandboxId: item.sandboxId,
        });
        await removeQuietly(containerRef, item.sandboxId);
        return [];
      }

      await backend.startSandbox(containerRef);

      for (const warning of item.payload.warnings) {
        log("warn", "provisioning warning", {
          sandboxId: item.sandboxId,
          warning,
        });
      }

      // `running` is reported by the supervisor connecting (supervisor.ready),
      // not here: a container that starts but whose supervisor never comes up
      // is not a working agent.
      events.push({
        kind: "sandbox.status",
        sandboxId: item.sandboxId,
        status: "starting",
        containerRef,
        homeRef,
      });
    } catch (error) {
      // A failed fresh create holds no capacity — without this a string of
      // failures would eat the admitted set until nothing could start.
      admittedNew.delete(item.sandboxId);
      log("error", "sandbox start failed", {
        sandboxId: item.sandboxId,
        error: String(error),
      });
      // Classified HERE — the runner is the only party that saw the typed
      // error. The control plane maps the code to user-facing copy; the raw
      // string is the operator trail. Typed against the shared vocabulary so
      // a typo cannot silently degrade to the generic copy.
      const reasonCode: SandboxStartFailureReason =
        error instanceof ImageUnavailableError
          ? "image_unavailable"
          : error instanceof SandboxCapacityError
            ? "at_capacity"
            : "start_failed";
      events.push({
        kind: "sandbox.status",
        sandboxId: item.sandboxId,
        status: "failed",
        error: String(error),
        reasonCode,
      });
    }

    return events;
  };

  const stopSandbox = async (item: StopItem): Promise<RunnerEvent[]> => {
    const snapshot = (await backend.listSandboxes()).find(
      (candidate) => candidate.sandboxId === item.sandboxId,
    );
    const ref = snapshot?.containerRef ?? item.containerRef;

    // Nothing to stop is the desired end state, not an error.
    if (!ref) {
      return [
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "stopped",
        },
      ];
    }

    try {
      await stopContainer(item.sandboxId, ref);
      return [
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "stopped",
        },
      ];
    } catch (error) {
      log("error", "sandbox stop failed", {
        sandboxId: item.sandboxId,
        error: String(error),
      });
      return [
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "failed",
          error: String(error),
        },
      ];
    }
  };

  /** Stop ONE container by ref and park its home: a deliberate stop's body,
   * shared with reconcile's stray-container backstop. Throws what the
   * backend throws; each caller decides what a failure means. */
  const stopContainer = async (sandboxId: string, ref: string) => {
    await backend.stopSandbox(ref, sandboxId);
    // A deliberate stop releases the sandbox's admitted-capacity slot: a
    // stopped container stays listed (not running) forever on some
    // substrates, so the in-check prune alone would hold its slot and refuse
    // admissible starts with capacity to spare. (Its process rows are now
    // stale; the control plane's lost sweep terminalizes them.)
    admittedNew.delete(sandboxId);
    // Addressed by name: a park of a home that was never born is the
    // backend's no-op, so this needs no lookup first.
    await backend.parkHome(backend.homeRefFor(sandboxId));
  };

  /**
   * Per-sandbox delivery chains: a turn with attachments PULLS bytes before
   * its frames go out, and that async work must neither stall the tick loop
   * (other sandboxes' lifecycle) nor let two deliveries to the SAME sandbox
   * interleave their frames. A settled chain removes itself so the map never
   * grows past the live sandboxes.
   */
  const deliveryChains = new Map<string, Promise<void>>();
  const enqueueDelivery = (
    sandboxId: string,
    task: () => Promise<void>,
  ): void => {
    const previous = deliveryChains.get(sandboxId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      log("warn", "sandbox delivery task failed", {
        sandboxId,
        error: String(error),
      });
    });
    deliveryChains.set(sandboxId, next);
    void next.finally(() => {
      if (deliveryChains.get(sandboxId) === next) {
        deliveryChains.delete(sandboxId);
      }
    });
  };

  /**
   * Pull a message's files from the control plane and stream each one down
   * the sandbox's channel as `attachment.part` frames, ahead of the message
   * frame they belong to (the same-socket order plus the supervisor's
   * sync-queue apply is the whole "files are on disk before the words"
   * guarantee). One file that fails to pull or verify is skipped, logged,
   * and the message still goes (the agent's read fails honestly; the note
   * said what was expected). Returns false when the socket closed mid-way:
   * the caller decides what that means for its message.
   *
   * The socket is re-resolved per file: it may have closed during a pull
   * (frames to a closed socket would throw and lose the remaining files).
   * A closed socket is never waited for here: the supervisor may come back
   * on another copy, which is handed the message's work from then on.
   */
  const streamAttachments = async (
    sandboxId: string,
    messageId: string,
    manifest: readonly AttachmentManifestEntry[],
  ): Promise<boolean> => {
    for (const entry of manifest) {
      try {
        const bytes = await controlPlane.fetchAttachment(entry.id);
        if (!verifyPulledAttachment(entry, bytes)) {
          log("warn", "attachment bytes failed verification; skipped", {
            attachmentId: entry.id,
            turnId: messageId,
          });
          continue;
        }
        const live = wsServer.connection(sandboxId);
        if (!live) {
          log("warn", "sandbox channel closed mid attachment delivery", {
            sandboxId,
            turnId: messageId,
          });
          return false;
        }
        for (const frame of attachmentPartFrames(messageId, entry, bytes)) {
          live.send(frame);
        }
      } catch (error) {
        log("warn", "attachment pull failed; message delivers without it", {
          attachmentId: entry.id,
          turnId: messageId,
          error: String(error),
        });
      }
    }
    return true;
  };

  /**
   * Hand a turn to its sandbox and return at once. Deliberately NOT awaited:
   * a turn can run for minutes, and `tick` executes items serially, so
   * awaiting one would stall every other sandbox's lifecycle behind it. The
   * turn's progress comes back asynchronously over the control channel.
   *
   * A turn with an attachments manifest first pulls each file's bytes from
   * the control plane and streams them as `attachment.part` frames, THEN
   * sends the turn frame — the same-socket ordering plus the supervisor's
   * sync-queue apply is the whole "files are on disk before the turn starts"
   * guarantee. A failed pull degrades to delivering the turn without that
   * file (the agent's read fails honestly; the context note said what was
   * expected). Steers/aborts that overtake this async delivery are safe by
   * the supervisor's own machinery (steer inbox, pending aborts).
   *
   * The control plane hands a turn only to the copy holding the sandbox's
   * open socket, so arriving here without one means the socket closed in
   * between (the supervisor is reconnecting, possibly to another copy). The
   * turn is GIVEN BACK, never failed: a death report for a turn the harness
   * never started re-queues it invisibly (the control plane's revival door),
   * and it is dispatched again to whichever copy holds the socket next.
   * Whether the sandbox itself is dead is the reconciler's call, from the
   * control plane's facts, never this copy's.
   */
  const deliverTurn = (
    item: Extract<RunnerWorkItem, { kind: "turn.deliver" }>,
  ): RunnerEvent[] => {
    const giveBack = (): RunnerEvent[] => [
      {
        kind: "turn.finished",
        sandboxId: item.sandboxId,
        conversationId: item.conversationId,
        turnId: item.turnId,
        status: "failed",
        // Raw prose stays for an old control plane; a new one maps the
        // CODE to its canonical copy and, for a turn that never started,
        // revives it instead of failing it at all.
        error: "The agent was restarting. Send the message again.",
        errorCode: TURN_FAILURE_CODES.agentRestarted,
      },
    ];

    const turnFrame = {
      kind: "turn.deliver" as const,
      turnId: item.turnId,
      conversationId: item.conversationId,
      message: item.message,
      ...(item.resumeSessionRef && {
        resumeSessionRef: item.resumeSessionRef,
      }),
      // Delivery-only memory context (step 8) — forwarded verbatim; the
      // supervisor concatenates, the transcript never sees it.
      ...(item.context && { context: item.context }),
      ...(item.attachments &&
        item.attachments.length > 0 && { attachments: item.attachments }),
    };

    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      log("info", "turn for a socket that just closed; giving it back", {
        sandboxId: item.sandboxId,
        turnId: item.turnId,
      });
      return giveBack();
    }
    const manifest = item.attachments ?? [];
    if (manifest.length === 0) {
      connection.send(turnFrame);
      return [];
    }

    const deliver = async (): Promise<void> => {
      // A socket that closed mid-pull is given back, never waited for: the
      // supervisor may come back on another copy, which is then handed it.
      if (!(await streamAttachments(item.sandboxId, item.turnId, manifest))) {
        await report(giveBack());
        return;
      }
      const live = wsServer.connection(item.sandboxId);
      if (!live) {
        await report(giveBack());
        return;
      }
      live.send(turnFrame);
    };
    enqueueDelivery(item.sandboxId, deliver);
    return [];
  };

  const abortTurn = (
    item: Extract<RunnerWorkItem, { kind: "turn.abort" }>,
  ): RunnerEvent[] => {
    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      // Nothing is running it, so it is already as stopped as it can be.
      return [
        {
          kind: "turn.finished",
          sandboxId: item.sandboxId,
          conversationId: item.conversationId,
          turnId: item.turnId,
          status: "aborted",
        },
      ];
    }
    connection.send({
      kind: "turn.abort",
      turnId: item.turnId,
      conversationId: item.conversationId,
    });
    return [];
  };

  /**
   * Forward a frame that must stay BEHIND whatever this sandbox's delivery
   * chain is still sending (a turn or a follow-up pulling its files): a
   * steer, or a Send now, overtaking it would reach the supervisor before
   * the message it follows. With nothing in flight it goes at once, the
   * common case; otherwise it rides the chain. Either way the channel is
   * resolved when the frame is SENT, and a missing one is a strict no-op
   * (`onNoChannel` logs it): recovery for both kinds lives control-plane
   * side (a steer that never arrived promotes; a Send now was a wish about
   * a live run).
   */
  const forwardInOrder = (
    sandboxId: string,
    send: (connection: SupervisorConnection) => void,
    onNoChannel: () => void,
  ): void => {
    const sendNowOrSkip = () => {
      const connection = wsServer.connection(sandboxId);
      if (connection) send(connection);
      else onNoChannel();
    };
    if (!deliveryChains.has(sandboxId)) {
      sendNowOrSkip();
      return;
    }
    enqueueDelivery(sandboxId, async () => sendNowOrSkip());
  };

  /**
   * Steer a mid-run follow-up down the control channel. No channel is a
   * strict NO-OP, deliberately unlike deliverTurn's corrective events: a
   * steer's recovery lives control-plane-side (the target turn strand-fails
   * and the follow-up is PROMOTED into an ordinary queued turn), so a
   * synthetic failure here would terminalize a message that is about to run
   * anyway, and a `stopped` report would knock a healthy-but-reconnecting
   * sandbox into a needless respawn cycle.
   *
   * A follow-up WITH files pulls them first, on the sandbox's delivery
   * chain, exactly like a turn's, then sends its frame. It starts only on a
   * live socket (none: skipped, promotion covers it), and a socket that
   * closes mid-pull is skipped the same way, never waited for on this copy:
   * the supervisor may come back on another one. Promotion then runs the
   * message as an ordinary turn, files included.
   */
  const steerMessage = (
    item: Extract<RunnerWorkItem, { kind: "turn.message" }>,
  ): RunnerEvent[] => {
    const manifest = item.attachments ?? [];
    const skipped = () =>
      log("info", "steer skipped, no live channel; promotion will cover it", {
        sandboxId: item.sandboxId,
        turnId: item.turnId,
      });
    const sendSteer = (connection: SupervisorConnection) =>
      connection.send({
        kind: "turn.message",
        turnId: item.turnId,
        targetTurnId: item.targetTurnId,
        conversationId: item.conversationId,
        message: item.message,
        // The delivery-only frame, forwarded verbatim like a turn's context:
        // the supervisor prepends it, the transcript never sees it.
        ...(item.context && { context: item.context }),
        ...(manifest.length > 0 && { attachments: manifest }),
      });
    if (manifest.length === 0) {
      forwardInOrder(item.sandboxId, sendSteer, skipped);
      return [];
    }
    if (!wsServer.connection(item.sandboxId)) {
      skipped();
      return [];
    }
    enqueueDelivery(item.sandboxId, async () => {
      if (!(await streamAttachments(item.sandboxId, item.turnId, manifest))) {
        skipped();
        return;
      }
      const live = wsServer.connection(item.sandboxId);
      if (live) sendSteer(live);
      else skipped();
    });
    return [];
  };

  /**
   * Forward a SEND NOW request, behind the steer it asks about (the claim
   * always composes it after that steer's delivery, and a steer pulling
   * files is still on the chain). No channel is a strict NO-OP like a
   * steer's: the request is best-effort by design, the follow-up is still
   * read after the tool ends (or promoted if the run strands), and nothing
   * is gained by inventing an outcome the sandbox never reported.
   */
  const sendNow = (
    item: Extract<RunnerWorkItem, { kind: "turn.send_now" }>,
  ): RunnerEvent[] => {
    forwardInOrder(
      item.sandboxId,
      (connection) =>
        connection.send({
          kind: "turn.send_now",
          turnId: item.turnId,
          targetTurnId: item.targetTurnId,
          conversationId: item.conversationId,
        }),
      () =>
        log("info", "send now skipped, no live channel", {
          sandboxId: item.sandboxId,
          turnId: item.turnId,
        }),
    );
    return [];
  };

  /**
   * Desktop control: a person took or gave back the screen. A
   * pass-through on the sandbox's channel, in order with the steers it may
   * precede. No live channel is a NO-OP like sendNow's: the control plane
   * re-sends the current state on its next change, and the supervisor's
   * handler is idempotent.
   */
  const desktopControl = (
    item: Extract<RunnerWorkItem, { kind: "desktop.control" }>,
  ): RunnerEvent[] => {
    forwardInOrder(
      item.sandboxId,
      (connection) =>
        connection.send({
          kind: "desktop.control",
          controlled: item.controlled,
          ...(item.controllerName !== undefined && {
            controllerName: item.controllerName,
          }),
        }),
      () =>
        log("info", "desktop control skipped, no live channel", {
          sandboxId: item.sandboxId,
          controlled: item.controlled,
        }),
    );
    return [];
  };

  /**
   * Fan a home sync's parts down the sandbox's control channel, in
   * order, on the one socket — which is the whole ordering guarantee. No
   * channel is a strict NO-OP, deliberately unlike deliverTurn's corrective
   * events: the sync is self-healing by generations (the un-acked claim
   * re-arms after its paced window, and a parked sandbox re-materializes at
   * its next boot), while reporting `stopped` here would knock a
   * healthy-but-reconnecting sandbox into a needless respawn cycle.
   */
  const syncHome = (
    item: Extract<RunnerWorkItem, { kind: "skills.changed" }>,
  ): RunnerEvent[] => {
    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      log("info", "home sync skipped — no live channel", {
        sandboxId: item.sandboxId,
        generation: item.generation,
      });
      return [];
    }
    item.parts.forEach((part, index) => {
      connection.send({
        kind: "skills.changed",
        generation: item.generation,
        part: index + 1,
        of: item.parts.length,
        files: part.files,
        ...(part.prune && { prune: part.prune }),
        ...(part.instructions !== undefined && {
          instructions: part.instructions,
        }),
        ...(part.agentName !== undefined && { agentName: part.agentName }),
        ...(part.channels !== undefined && { channels: part.channels }),
        // Every final-part render input must be relayed: a field dropped
        // here reads as "unchanged" at the supervisor, so the doc would
        // only catch up at the next boot.
        ...(part.peers !== undefined && { peers: part.peers }),
        ...(part.connections !== undefined && {
          connections: part.connections,
        }),
      });
    });
    return [];
  };

  /**
   * Dispatch for the channel-send kinds. Starts and stops never reach this —
   * `enqueueWork` routes them through their dedupe slots and (for starts)
   * the semaphore; the narrowed type is what keeps a new lifecycle kind from
   * silently bypassing that machinery.
   */
  const execute = async (
    item: Exclude<RunnerWorkItem, StartItem | StopItem>,
  ): Promise<RunnerEvent[]> => {
    switch (item.kind) {
      case "turn.deliver":
        return deliverTurn(item);
      case "turn.abort":
        return abortTurn(item);
      case "turn.message":
        return steerMessage(item);
      case "turn.send_now":
        return sendNow(item);
      case "skills.changed":
        return syncHome(item);
      case "desktop.control":
        return desktopControl(item);
      default: {
        const unreachable: never = item;
        throw new Error(`unhandled work item: ${JSON.stringify(unreachable)}`);
      }
    }
  };

  /**
   * Containers this copy has already REPORTED (dead or channelless, or a
   * boot crash), keyed by containerRef: one report per container. The
   * control plane's guards make repeats inert anyway, but a deliberately
   * parked sandbox is also dead-with-no-channel, and without this every
   * pass would re-report every parked container forever. Bounded by the
   * containers this copy ever observes.
   */
  const reportedDead = new Set<string>();

  /**
   * Containers this copy has claimed and is stopping as strays: one stop
   * per container. Separate from `reportedDead` on purpose: the usual
   * stray WAS reported first (the report is what parked its row), and the
   * stop it then needs must not be swallowed by that report's dedupe. A
   * refused claim or a failed stop drops its ref so the next pass retries.
   */
  const strayStopped = new Set<string>();

  /**
   * Sandboxes the control plane believed `running` that had NO backend
   * snapshot on the PREVIOUS reconcile pass — the vanished-pod arm's memory.
   * Absence must be observed on two consecutive passes before it is
   * reported: a false positive here reports `stopped` over a healthy agent,
   * which fails its started turns and recreates its container mid-work, so
   * one stale read (a stop mid-execution after its queue slot drained, a
   * status fetched just before the claim flipped it) must never be enough.
   * Rebuilt wholesale each pass, so reappearance — or any pass without an
   * observation — resets the clock.
   */
  let missingWhileRunning = new Set<string>();

  /** Set at registration; the sweep refuses to run without it — before
   * `identify()` every managed object would look foreign. */
  let registeredRunnerId: string | undefined;

  /** This installation's fingerprint — the sweep reaps only objects bearing
   * it, so a co-located install's objects are never candidates. */
  const myInstallationId = installationFingerprint(config.token);

  /**
   * THE STALE-LABEL ORPHAN SWEEP (step 13). The owned loops above reap what
   * carries THIS runner's label; objects labeled by a runner id that no
   * longer exists — a control-plane reset minted a fresh id, a rotated
   * token — are invisible to them forever. This sweep enumerates EVERY
   * platform-labeled container and volume, and destroys the ones whose
   * sandbox id the control plane says exists nowhere, in that order:
   * authority first, destruction second, never on a partial answer.
   *
   * Safety fences, each load-bearing:
   *  - a DIFFERENT installation's objects are skipped (the installation-id
   *    fence): listManaged enumerates the whole daemon, so on a shared host
   *    two installs would otherwise see each other's live objects as orphans
   *    (their runner ids differ and their sandbox ids are unknown to each
   *    other's control plane) and destroy them. The fingerprint is a hash of
   *    the runner token — stable across a database reset (so the SAME
   *    install's dead-runner-id objects are still reaped) and different per
   *    install. An absent label (a pre-fix object) is treated as foreign;
   *  - my own runner label is skipped (the expected-set loops own it);
   *  - unidentifiable (no sandbox-id label) and unageable (no timestamp)
   *    objects are logged, never deleted;
   *  - a grace window (default 1h) spares mid-spawn siblings and freshly
   *    created objects whose rows are still landing;
   *  - the existence check protects live siblings by construction — their
   *    Sandbox rows exist before their objects do;
   *  - any check failure (an older control plane 404s the endpoint, a
   *    transport blip) aborts the whole sweep with zero destruction;
   *  - RUNNER_ORPHAN_REAP=false detects and logs, deletes nothing.
   */
  const sweepStaleOrphans = async (): Promise<void> => {
    const myId = registeredRunnerId;
    if (!myId) return;

    let managed;
    try {
      managed = await backend.listManaged();
    } catch (error) {
      log("warn", "orphan sweep could not list managed objects", {
        error: String(error),
      });
      return;
    }

    const graceBefore = Date.now() - config.orphanGraceSeconds * 1000;
    const candidates = managed.flatMap((object) => {
      // A different install (or a pre-fix object with no installation label)
      // is NEVER this sweep's business — its liveness lives in another
      // control plane we cannot ask.
      if (object.installationId !== myInstallationId) return [];
      if (object.runnerId === myId) return [];
      if (!object.sandboxId) {
        log("warn", "unidentifiable managed object (no sandbox-id label)", {
          kind: object.kind,
          ref: object.ref,
        });
        return [];
      }
      if (!object.createdAt) {
        log("warn", "unageable managed object (no creation timestamp)", {
          kind: object.kind,
          ref: object.ref,
        });
        return [];
      }
      if (object.createdAt.getTime() >= graceBefore) return [];
      return [
        {
          kind: object.kind,
          ref: object.ref,
          sandboxId: object.sandboxId,
          runnerId: object.runnerId,
        },
      ];
    });
    if (candidates.length === 0) return;

    const uniqueIds = [
      ...new Set(candidates.map((object) => object.sandboxId)),
    ];
    const missing = new Set<string>();
    try {
      for (let i = 0; i < uniqueIds.length; i += MAX_SANDBOX_CHECK_IDS) {
        const batch = uniqueIds.slice(i, i + MAX_SANDBOX_CHECK_IDS);
        for (const id of await controlPlane.checkSandboxIds(batch)) {
          missing.add(id);
        }
      }
    } catch (error) {
      log("warn", "orphan sweep aborted before any destruction", {
        error: String(error),
      });
      return;
    }

    for (const object of candidates) {
      if (!missing.has(object.sandboxId)) continue;
      if (!config.orphanReap) {
        log("warn", "stale-label orphan detected (reap disabled, would reap)", {
          kind: object.kind,
          ref: object.ref,
          sandboxId: object.sandboxId,
          labeledRunnerId: object.runnerId,
        });
        continue;
      }
      log("warn", "reaping stale-label orphan", {
        kind: object.kind,
        ref: object.ref,
        sandboxId: object.sandboxId,
        labeledRunnerId: object.runnerId,
      });
      try {
        if (object.kind === "sandbox") {
          await backend.stopSandbox(object.ref, object.sandboxId);
          await backend.removeSandbox(object.ref, object.sandboxId);
        } else {
          await backend.destroyHome(object.ref);
        }
      } catch (error) {
        log("warn", "failed to reap stale-label orphan", {
          kind: object.kind,
          ref: object.ref,
          error: String(error),
        });
      }
    }
  };

  /**
   * When THIS copy became the reconciler (null while it is not): the
   * earliest moment it could have started watching sandboxes whose holder
   * died reconnect elsewhere, so the inherited grace never starts before it.
   */
  let reconcilerSince: number | null = null;

  /**
   * One container's verdict, acted on. Every report names the container it
   * is about (`observedContainerRef`), so the control plane applies it only
   * while that is still the sandbox's container: an observation that lands
   * after another copy started a fresh one changes nothing.
   */
  const actOn = async (
    snapshot: SandboxSnapshot,
    assigned: RunnerSandboxesResponse,
    since: number,
  ): Promise<RunnerEvent[]> => {
    const { sandboxId, containerRef } = snapshot;
    const verdict = classifySandbox({
      snapshot,
      believed: assigned.statuses?.[sandboxId],
      channel: assigned.channels?.[sandboxId],
      now: Date.now(),
      reconcilerSince: since,
      sessions: wsServer.resumable,
      graces: {
        bootDialInMs: bootDialInGraceMs,
        droppedMs: SESSION_RESUME_GRACE_MS,
        inheritedMs: inheritedResumeGraceMs,
      },
    });
    if (verdict === "leave") return [];
    if (
      verdict === "stray"
        ? strayStopped.has(containerRef)
        : reportedDead.has(containerRef)
    ) {
      return [];
    }

    switch (verdict) {
      case "boot-crash":
        /**
         * BOOT CRASH: the spawn died before its supervisor ever connected,
         * and its dial-in grace is over. Unclassified, the control plane
         * would respawn it every 30s for the full turn ceiling while the
         * churn pins capacity. `start_failed` rides the 150s patience
         * window (the queue parks with honest copy), and the corpse is
         * removed: it still holds its home, which the control plane can
         * neither archive nor release while the dead container exists.
         */
        reportedDead.add(containerRef);
        log("warn", "sandbox exited before its supervisor connected", {
          sandboxId,
        });
        await removeQuietly(containerRef, sandboxId);
        admittedNew.delete(sandboxId);
        return [
          {
            kind: "sandbox.status",
            sandboxId,
            status: "failed",
            error: "sandbox exited before the supervisor connected",
            reasonCode: "start_failed" satisfies SandboxStartFailureReason,
            observedContainerRef: containerRef,
          },
        ];
      case "stray":
        /**
         * A STRAY: running, no channel, and the control plane already parked
         * its row. A report would change nothing, so it is stopped, through
         * the deliberate stop's own body, once the control plane agrees no
         * start has taken it (the claim moves the row to `stopping` under
         * this copy, fenced on the container). The stop's `stopped` then
         * lands like any stop's.
         */
        strayStopped.add(containerRef);
        if (!(await controlPlane.claimStrayStop(sandboxId, containerRef))) {
          strayStopped.delete(containerRef);
          return [];
        }
        log("warn", "stopping a running container whose sandbox is parked", {
          sandboxId,
        });
        chains.enqueue(sandboxId, async () => {
          try {
            await stopContainer(sandboxId, containerRef);
            await enqueueReport([
              {
                kind: "sandbox.status",
                sandboxId,
                status: "stopped",
                observedContainerRef: containerRef,
              },
            ]);
          } catch (error) {
            strayStopped.delete(containerRef);
            log("warn", "stopping a stray container failed; retrying", {
              sandboxId,
              error: String(error),
            });
          }
        });
        return [];
      case "channelless":
      case "dead":
        /**
         * RUNNING BUT UNREACHABLE, or DEAD WITH NO CHANNEL. Saying `stopped`
         * is the truth from the control plane's view, and it rejoins the
         * ordinary wake path: the strand law revives or fails the in-flight
         * turns and the next message recreates the container. A sandbox
         * parked deliberately absorbs the report as a no-op (the status
         * guard), and one report per container keeps a parked one from
         * being re-reported every pass.
         */
        reportedDead.add(containerRef);
        log("warn", "sandbox has no control channel; reporting it stopped", {
          sandboxId,
          running: snapshot.running,
        });
        return [
          {
            kind: "sandbox.status",
            sandboxId,
            status: "stopped",
            observedContainerRef: containerRef,
          },
        ];
    }
  };

  const reconcilePass = async (): Promise<void> => {
    // One copy reconciles (the oldest live one, picked by the control plane;
    // a single-process runner always does), so N copies never report or
    // destroy the same container N times. The others only serve sockets,
    // and ask for their role alone: the listing is every sandbox's row, and
    // a copy that will not reconcile needs none of it. An api too old to
    // answer the role read alone (`undefined`) leaves the listing to say.
    const standDown = () => {
      reconcilerSince = null;
      missingWhileRunning = new Set();
    };
    if ((await controlPlane.isReconciler()) === false) return standDown();
    const assigned = await controlPlane.listAssignedSandboxes();
    if (assigned.reconciler === false) return standDown();
    const since = (reconcilerSince ??= Date.now());
    const expected = new Set(assigned.sandboxIds);
    const reports: RunnerEvent[] = [];

    // Statuses first, snapshots second, so a sandbox can only APPEAR between
    // the reads, never leave a healthy sandbox looking vanished.
    const snapshots = await backend.listSandboxes();
    /** This copy's own lifecycle work in flight: its verdicts wait. */
    const busy = (sandboxId: string) =>
      queuedStarts.has(sandboxId) ||
      executingStartHash.has(sandboxId) ||
      queuedStops.has(sandboxId);

    for (const snapshot of snapshots) {
      if (expected.has(snapshot.sandboxId)) {
        if (!busy(snapshot.sandboxId)) {
          reports.push(...(await actOn(snapshot, assigned, since)));
        }
        continue;
      }
      log("info", "reaping orphaned sandbox", {
        sandboxId: snapshot.sandboxId,
      });
      try {
        await backend.stopSandbox(snapshot.containerRef, snapshot.sandboxId);
        await backend.removeSandbox(snapshot.containerRef, snapshot.sandboxId);
        admittedNew.delete(snapshot.sandboxId);
      } catch (error) {
        log("warn", "failed to reap sandbox container", {
          sandboxId: snapshot.sandboxId,
          error: String(error),
        });
      }
    }

    /**
     * THE VANISHED-POD ARM: a sandbox the control plane believes `running`
     * with no container at all (deleted out of band), absent on TWO
     * consecutive passes, is reported `stopped`: the strand law then
     * revives or fails its turns and the next message wakes it. A sandbox
     * with lifecycle work in flight here counts as present (its create may
     * be mid-call). No `reportedDead`: a landed report flips the row off
     * `running`, so pacing is inherent.
     *
     * The report names the container the control plane believes it has
     * (the one found missing): the reconciler is often not the sandbox's
     * owner, and a named report applies whoever owns it, but only while
     * that container is still the sandbox's, so a start that replaced it
     * meanwhile is never knocked down.
     */
    const present = new Set(snapshots.map((snapshot) => snapshot.sandboxId));
    for (const sandboxId of Object.keys(assigned.statuses ?? {})) {
      if (busy(sandboxId)) present.add(sandboxId);
    }
    const vanished = vanishedSandboxes(
      assigned.statuses,
      present,
      missingWhileRunning,
    );
    missingWhileRunning = vanished.missing;
    for (const sandboxId of vanished.report) {
      log("warn", "sandbox vanished from the backend while believed running", {
        sandboxId,
      });
      const believedRef = assigned.channels?.[sandboxId]?.containerRef;
      reports.push({
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
        ...(believedRef && { observedContainerRef: believedRef }),
      });
      // The sandbox is gone: release its admitted-capacity slot, or the
      // recovery start for it would count its own stale admission.
      admittedNew.delete(sandboxId);
    }

    // Volumes are reaped separately: a sandbox whose container was already
    // removed still leaves its (durable, deliberately persistent) home.
    for (const home of await backend.listHomes()) {
      if (expected.has(home.sandboxId)) continue;
      log("info", "reaping orphaned home", { sandboxId: home.sandboxId });
      try {
        await backend.destroyHome(home.ref);
      } catch (error) {
        log("warn", "failed to reap home", {
          sandboxId: home.sandboxId,
          error: String(error),
        });
      }
    }

    if (reports.length > 0) await report(reports);

    // Last, so the owned truth settles first, and its internal try/catch
    // discipline means a sweep problem can never fail reconcile (or boot).
    await sweepStaleOrphans();
  };

  /**
   * Reconcile passes must never OVERLAP: `missingWhileRunning` is cross-pass
   * memory, and
   * a slow pass (a wedged backend, a fleet of corpses to reap) overlapping a
   * fresh interval tick would let two stale reads of ONE window count as
   * "consecutive" — reporting `stopped` over a healthy agent, exactly what
   * the two-pass fence exists to prevent. A skipped call is covered by the
   * next tick; the boot reconcile is awaited before the interval starts.
   */
  let reconcileInFlight = false;
  const reconcile = async (): Promise<void> => {
    if (reconcileInFlight) return;
    reconcileInFlight = true;
    try {
      await reconcilePass();
    } finally {
      reconcileInFlight = false;
    }
  };

  /**
   * A SOCKET CLOSED: did its container die? The copy that held the socket is
   * the only party that sees the close the moment it happens, so it looks at
   * that sandbox's container right away. Dead: it is reported `stopped` now,
   * stamped with that container (a report about a container that was already
   * replaced changes nothing), so the next message wakes the sandbox on the
   * ordinary path. Without this, work for it waits for a socket that can
   * never come back until the reconciler's next pass (a minute in
   * production), and the next message sits queued meanwhile. Alive: its
   * supervisor is reconnecting (here or to another copy) and nothing is
   * said. Lifecycle work in flight here speaks for itself. One report per
   * container, shared with the reconciler's.
   *
   * The socket closes a moment BEFORE the substrate reads the container as
   * exited (a SIGKILL'd container still reads `running` for ~100 ms), so one
   * look right at the close would call a dying container alive. A few short
   * looks cover it; a live supervisor's container stays running throughout.
   * The container looked at is the one the socket was FOR: gone from the
   * substrate (a deleted pod) is as dead as exited, and a newer container
   * for the sandbox (a start replaced it) is not this check's business.
   *
   * Closes that land together share ONE listing per look (a node lost takes
   * many sockets at once, and a listing is a cluster API call). Closes from
   * a copy's own shutdown are not looked at: its drain closed them, and the
   * supervisors move to another copy.
   */
  /** sandboxId → a closed socket still being looked at: the container it
   * was for, and how many looks it has had. */
  const closedPending = new Map<
    string,
    { containerRef: string; looks: number }
  >();
  let closedSweep: Promise<void> | undefined;

  const closedStillOpen = (sandboxId: string, containerRef: string) =>
    !reportedDead.has(containerRef) &&
    !lifecycleInFlight.has(sandboxId) &&
    !wsServer.connection(sandboxId);

  const lookAtClosed = async (): Promise<void> => {
    const snapshots = await backend.listSandboxes();
    const dead: RunnerEvent[] = [];
    for (const [sandboxId, entry] of closedPending) {
      // Checked after the listing: a start may have begun meanwhile.
      if (!closedStillOpen(sandboxId, entry.containerRef)) {
        closedPending.delete(sandboxId);
        continue;
      }
      const own = snapshots.filter((s) => s.sandboxId === sandboxId);
      if (own.some((s) => s.containerRef !== entry.containerRef)) {
        closedPending.delete(sandboxId);
        continue;
      }
      if (own.some((s) => s.running)) {
        entry.looks += 1;
        // Still running after every look: its supervisor is reconnecting.
        if (entry.looks >= CLOSED_CHANNEL_LOOKS)
          closedPending.delete(sandboxId);
        continue;
      }
      closedPending.delete(sandboxId);
      reportedDead.add(entry.containerRef);
      log("warn", "sandbox's container died with its control channel", {
        sandboxId,
        gone: own.length === 0,
      });
      dead.push({
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
        observedContainerRef: entry.containerRef,
      });
    }
    if (dead.length > 0) await report(dead);
  };

  const sweepClosed = async (): Promise<void> => {
    for (let first = true; closedPending.size > 0; first = false) {
      if (!first) await sleep(closedChannelLookMs);
      await lookAtClosed();
    }
  };

  const startClosedSweep = (): void => {
    if (closedSweep) return;
    closedSweep = sweepClosed()
      .catch((error: unknown) => {
        // The reconciler's next pass catches whatever this one missed.
        log("warn", "could not check closed channels' containers", {
          error: String(error),
        });
        closedPending.clear();
      })
      .finally(() => {
        closedSweep = undefined;
      });
  };

  wsServer.onDisconnect((sandboxId, containerRef) => {
    // Off the sandbox's chain (the looks must not hold a start or a stop
    // behind them); the in-flight lifecycle checks keep it out of their way.
    if (stopping) return;
    closedPending.set(sandboxId, { containerRef, looks: 0 });
    startClosedSweep();
  });

  /**
   * Route one claimed item onto its sandbox's chain. Cross-sandbox
   * order is NOT preserved — per-sandbox order is, and that is where every
   * documented ordering invariant lives. At `lifecycleConcurrency: 1` the
   * semaphore keeps backend-touching work (starts) globally serialized
   * exactly as the old serial tick did — docker operations on one host
   * contend, and a burst of parallel image pulls is how a laptop falls over.
   */
  const enqueueWork = (item: RunnerWorkItem): void => {
    if (item.kind === "sandbox.start") {
      const queued = queuedStarts.get(item.sandboxId);
      if (queued) {
        // SUPERSEDE, never absorb: the twin was composed at dispatch from
        // CURRENT truth (a rotated token rides it), so the queued slot takes
        // the newest payload and keeps its position. One settlement report
        // satisfies both claims — they are the same sandbox row.
        queued.item = item;
        return;
      }
      const executingHash = executingStartHash.get(item.sandboxId);
      if (
        executingHash !== undefined &&
        executingHash === payloadHash(item.payload)
      ) {
        // A re-dispatched twin of the start EXECUTING right now, with an
        // identical payload: absorbing it skips a pointless recreate of the
        // container that is booting this second. A DIFFERING hash queues —
        // that recreate is then correct (the credentials changed).
        return;
      }
      const slot = { item };
      queuedStarts.set(item.sandboxId, slot);
      beginLifecycle(item.sandboxId);
      beginStartHeartbeat(item.sandboxId);
      chains.enqueue(item.sandboxId, async () => {
        queuedStarts.delete(slot.item.sandboxId);
        const live = slot.item;
        executingStartHash.set(live.sandboxId, payloadHash(live.payload));
        const release = await startSlots.acquire();
        try {
          const events = await startSandbox(live);
          // Clear THEN enqueue, synchronously: no heartbeat can land after
          // the settlement it belongs to (the report chain orders the rest).
          // UNLESS a hash-differing twin is queued behind this start — the
          // timer then belongs to the SUCCESSOR (whose semaphore wait + wake
          // would otherwise run heartbeat-less and go stale at 300s).
          if (!queuedStarts.has(live.sandboxId)) {
            stopStartHeartbeat(live.sandboxId);
          }
          await enqueueReport(events);
        } finally {
          release();
          executingStartHash.delete(live.sandboxId);
          endLifecycle(live.sandboxId);
          if (!queuedStarts.has(live.sandboxId)) {
            stopStartHeartbeat(live.sandboxId);
          }
        }
      });
      return;
    }

    if (item.kind === "sandbox.stop") {
      const queued = queuedStops.get(item.sandboxId);
      if (queued) {
        queued.item = item;
        return;
      }
      const slot = { item };
      queuedStops.set(item.sandboxId, slot);
      beginLifecycle(item.sandboxId);
      // Semaphore-exempt (see the executor comment above).
      chains.enqueue(item.sandboxId, async () => {
        queuedStops.delete(slot.item.sandboxId);
        try {
          await enqueueReport(await stopSandbox(slot.item));
        } finally {
          endLifecycle(slot.item.sandboxId);
        }
      });
      return;
    }

    // Turn/steer/abort/sync items are synchronous channel sends — the chain
    // only orders them against this sandbox's lifecycle (a deliver claimed
    // after a start must reach the supervisor after that start settles).
    chains.enqueue(item.sandboxId, async () => {
      await enqueueReport(await execute(item));
    });
  };

  const tick = async (wait = POLL_WAIT_SECONDS): Promise<void> => {
    const items = await controlPlane.pollWork(wait, POLL_LIMIT);
    // Enqueue and RETURN — the poll cadence must not ride behind a
    // minutes-long wake. Completion is observable via `settle()`.
    for (const item of items) enqueueWork(item);
  };

  const settle = async (): Promise<void> => {
    await chains.settled();
    // Deliveries (attachment pulls) ride their own per-sandbox chains; a
    // drain that ignored them would report settled with a turn in hand.
    await Promise.all([...deliveryChains.values()]);
    // The closed-socket sweep too (it may be looking at a dead container).
    await closedSweep;
    await reportChain;
  };

  return {
    async start() {
      await backend.prepare();

      // Register BEFORE listening: a copy admits sockets only once it has an
      // identity, because every channel claim names the copy that holds it.
      const { runnerId, replicaId } = await registerWithRetry(
        controlPlane,
        config.controlPlaneUrl,
        {
          name: config.name,
          capabilities: capabilities(),
          replicaName: config.replicaName,
          ...(config.portApi && { portApiUrl: config.portApi.advertisedUrl }),
        },
      );
      registeredRunnerId = runnerId;
      log("info", "registered with control plane", {
        runnerId,
        replicaId,
        replicaName: config.replicaName,
        backend: backend.id,
      });

      // Before ANY object is created or matched: the backend labels with the
      // control plane's stable id, so a restart still recognizes its own
      // containers and volumes (a per-process id would leak them silently).
      backend.identify(runnerId);

      await wsServer.listen();
      await reconcile();

      heartbeatTimer = setInterval(() => {
        controlPlane.heartbeat(capabilities()).catch((error: unknown) => {
          log("warn", "heartbeat failed", { error: String(error) });
        });
      }, HEARTBEAT_MS);
      heartbeatTimer.unref?.();

      reconcileTimer = setInterval(() => {
        reconcile().catch((error: unknown) => {
          log("warn", "reconcile failed", { error: String(error) });
        });
      }, config.reconcileSeconds * 1000);
      reconcileTimer.unref?.();

      return runnerId;
    },

    tick,
    reconcile,
    settle,

    run() {
      running = true;
      loop = (async () => {
        let backoff = RETRY_MIN_MS;
        while (running) {
          try {
            await tick();
            backoff = RETRY_MIN_MS;
          } catch (error) {
            if (!running) break;
            log("warn", "poll cycle failed", {
              error: String(error),
              retryInMs: backoff,
            });
            await sleep(backoff);
            backoff = Math.min(backoff * 2, RETRY_MAX_MS);
          }
        }
      })();
      return loop;
    },

    async stop() {
      running = false;
      stopping = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      for (const sandboxId of [...startHeartbeats.keys()]) {
        stopStartHeartbeat(sandboxId);
      }
      // Give up this copy's identity FIRST, the moment shutdown starts: the
      // control plane hands it nothing new from here on (its poll already
      // parked on the server included), and the sandboxes it owned and the
      // reconciler role pass on at once instead of after the liveness
      // window. Best effort: a control plane that is down meanwhile only
      // means the window does the handover.
      await controlPlane.retire().catch((error: unknown) => {
        log("warn", "could not retire this runner copy", {
          error: String(error),
        });
      });
      // Then hand every supervisor over to another copy (they reconnect,
      // with their sessions, wherever the balancer sends them).
      await wsServer.drain();
      // The poll in flight may still return work claimed just before the
      // retire landed. It is this copy's by record, so it is run, not
      // dropped: a start still starts, and a turn whose socket just closed
      // is given back for whichever copy holds the socket next.
      await loop;
      await wsServer.close();
      // Sandboxes are deliberately left running: a stopped copy is a roll or
      // a restart, and the others (or its successor) carry on with them.
    },
  };
};
