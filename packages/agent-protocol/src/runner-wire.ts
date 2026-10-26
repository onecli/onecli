import { z } from "zod";
import { agentEventSchema, turnUsageSchema } from "./events";
import { AGENT_EFFORTS } from "./harness";
import {
  MAX_MEMORY_WRITE_BYTES,
  MEMORY_DESCRIPTION_MAX_LENGTH,
  MEMORY_FILE_CONTENT_MAX_CHARS,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  MEMORY_TITLE_MAX_LENGTH,
} from "./memory-file";
import { MAX_OUTBOUND_CAPTION_CHARS } from "./attachments";
import {
  MAX_AGENT_CHANNEL_PRESENCES,
  MAX_AGENT_CONNECTIONS,
  MAX_AGENT_PEERS,
  MAX_PREVIEW_RELAUNCHES,
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  MAX_TURN_CONTEXT_CHARS,
  MAX_DESKTOP_CONTROLLER_NAME_CHARS,
  agentChannelPresenceSchema,
  agentConnectionSchema,
  agentPeerSchema,
  attachmentManifestEntrySchema,
  previewRelaunchSchema,
  processStateSchema,
  listeningPortsSchema,
  syncFrameByteLength,
  homeRelativePathSchema,
  homeSyncFileSchema,
} from "./transport";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments";

/**
 * The runner↔control-plane wire (plans/hosted-agents-v2.md §5): registration,
 * the work long-poll, batched lifecycle events, heartbeat. This is the
 * dispatch half of the §3.17 seams — the shapes are deliberately backend- and
 * vendor-neutral (invariant 9): nothing here names a container runtime or a
 * harness implementation.
 *
 * Step 3 carried lifecycle only; step 4 added the turn verbs; step 9 adds
 * `skills.changed` (the home-projection push) and its
 * `home.synced` ack.
 */

/**
 * The `turn.message` id of a steer the PLATFORM writes into a running turn
 * (the approaching-ceiling warning), not a person: namespaced so it can
 * never collide with a follow-up row's id (uuids have no colon), and so a
 * reader can tell it apart. There is no row behind it, so there is nothing
 * to store an answer under: the agent's reply to it stays the turn's own.
 */
export const ceilingWarningSteerId = (turnId: string): string =>
  `ceiling-warning:${turnId}`;

/**
 * The steer the platform writes into a running turn when a person takes or
 * gives back control of the sandbox's desktop. Same law as the ceiling
 * warning: namespaced, no row behind it. The two directions get distinct
 * ids so a turn can receive both in order.
 */
export const desktopControlSteerId = (
  turnId: string,
  controlled: boolean,
): string => `desktop-${controlled ? "taken" : "released"}:${turnId}`;

/** True for a steer id the platform minted (see `ceilingWarningSteerId` and
 * `desktopControlSteerId`): one with no follow-up row behind it. */
export const isPlatformSteerId = (steerId: string): boolean =>
  steerId.startsWith("ceiling-warning:") ||
  steerId.startsWith("desktop-taken:") ||
  steerId.startsWith("desktop-released:");

/**
 * A message's user attachments on the poll, METADATA ONLY: bytes never ride
 * it (a claimed batch could otherwise reach hundreds of MB of JSON, and one
 * oversized or failed parse would poison every re-dispatch). The runner
 * pulls each file's bytes from `GET /v1/runner/attachments/:id`, chunks
 * them into `attachment.part` frames, and only then forwards the message
 * frame they belong to. One shape for a turn's files and a follow-up's.
 */
const messageAttachmentsSchema = z
  .array(attachmentManifestEntrySchema)
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .optional();

/** What a runner can do, declared at registration — capacity and posture. */
export const runnerCapabilitiesSchema = z.object({
  /** Concurrent-sandbox cap the runner enforces; placement respects it. */
  maxSandboxes: z.number().int().positive(),
  /** The sandbox backend id (reporting and placement input, never routing). */
  backend: z.string().min(1),
  /**
   * The backend's home durability class (§3.9): `resident` disks
   * survive on their own; `snapshot` backends archive on park.
   */
  homeDurability: z.enum(["resident", "snapshot"]),
  /**
   * This runner parses the `turn.message` work item. The steer dispatch arm
   * is gated on it because the runner's poll parse is all-or-nothing: an
   * unknown kind would poison whole claimed batches on an older runner, over
   * and over, until upgrade. Absent = false = follow-ups promote instead —
   * the queue-only degrade.
   */
  steerMessages: z.boolean().optional(),
  /**
   * This runner parses the `turn.send_now` work item. Same
   * all-or-nothing reason as `steerMessages`: the claim arm is gated on it,
   * so an older runner never receives the kind and a Send now request on
   * its sandbox simply stays a request. Absent = false.
   */
  sendNow: z.boolean().optional(),
  /**
   * This runner pulls attachment bytes (`GET /v1/runner/attachments/:id`)
   * and streams them into the sandbox ahead of the turn. Dispatch composes
   * the `turn.deliver` manifest + context note ONLY for capable runners —
   * otherwise the turn ships bare with no note, so the agent is never told
   * about files that cannot arrive. Absent = false.
   */
  attachments: z.boolean().optional(),
  /**
   * This runner pulls a mid-run follow-up's attachments ahead of its
   * `turn.message`, the way it does for a turn's. The steer arm hands a
   * follow-up WITH files only to a runner advertising this: an older one
   * would forward the words and drop the files, so its file-carrying
   * follow-ups promote and run as their own turn instead. Absent = false.
   */
  steerAttachments: z.boolean().optional(),
  /**
   * This runner relays files the agent sends back (`file.part` reassembly →
   * `POST /v1/runner/attachments`). The spawn env advertises the send_file
   * tool to the supervisor ONLY for capable runners — an older runner would
   * drop the frames on validation and the model would wait out a timeout for
   * a file that never left. Absent = false.
   */
  outboundAttachments: z.boolean().optional(),
  /**
   * This runner parses the `desktop.control` work item and forwards
   * `desktop.state`. Same all-or-nothing reason as `steerMessages`: the
   * claim arm is gated on it, so an older runner never receives the kind.
   * Without it the control plane never pushes a controller change, so the
   * sandbox never opens its input instance: takeover stays dark on that
   * runner, viewing is unaffected. Absent = false.
   */
  desktopControl: z.boolean().optional(),
});
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

/** The opt-in flags a runner may advertise: each one gates a work kind or
 * a payload the control plane sends only to a runner that said so. */
export type RunnerCapabilityFlag = {
  [K in keyof RunnerCapabilities]-?: NonNullable<
    RunnerCapabilities[K]
  > extends boolean
    ? K
    : never;
}[keyof RunnerCapabilities];

/**
 * Whether a runner's STORED capabilities (an untyped JSON column) advertise
 * one flag: the same fact the claim arms read in SQL, for a reader that
 * holds the row instead. Anything unparseable is false, the safe degrade
 * (the gated work or payload is simply never sent to it).
 */
export const runnerAdvertises = (
  capabilities: unknown,
  flag: RunnerCapabilityFlag,
): boolean => {
  const parsed = runnerCapabilitiesSchema.safeParse(capabilities);
  return parsed.success && parsed.data[flag] === true;
};

export const runnerRegisterRequestSchema = z.object({
  name: z.string().min(1).max(200),
  capabilities: runnerCapabilitiesSchema,
  /**
   * This process's own name (its hostname). Sent by a runner built to run as
   * one of several copies behind one registration: the control plane then
   * records the copy and answers `replicaId`. Absent from an older runner,
   * which keeps exactly the single-process behaviour.
   */
  replicaName: z.string().min(1).max(200).optional(),
  /**
   * Where this copy serves its internal port API (sandbox previews), as
   * `http://<pod address>:<port>`: the preview relay dials the copy that
   * holds a sandbox's socket here. Absent from a copy that serves none.
   */
  portApiUrl: z
    .url({ protocol: /^http$/ })
    .max(200)
    .optional(),
});
export type RunnerRegisterRequest = z.infer<typeof runnerRegisterRequestSchema>;

export const runnerRegisterResponseSchema = z.object({
  runnerId: z.string().min(1),
  /**
   * The copy id, answered when the request carried `replicaName`. Every
   * later call names it in `RUNNER_REPLICA_HEADER`.
   */
  replicaId: z.string().min(1).optional(),
});
export type RunnerRegisterResponse = z.infer<
  typeof runnerRegisterResponseSchema
>;

/**
 * Names the runner copy making a call. Every runner call after registration
 * carries it, which is what keeps the copy's liveness fresh and what the
 * control plane fences channel-bound work and channel records by. A call
 * without it is a single-process runner and is served exactly as before.
 */
export const RUNNER_REPLICA_HEADER = "x-onecli-runner-replica";

/** A lowercase hex SHA-256: the only form a bootstrap token ever reaches
 * the control plane in. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** A runner-chosen id for one supervisor socket. */
const connectionIdSchema = z.string().min(1).max(64);
/** Container refs are runner-supplied and land in the database. */
const containerRefSchema = z.string().min(1).max(200);

/**
 * PUT /v1/runner/sandboxes/:id/spawn: the starting copy records the spawn
 * it just created, before the sandbox boots: the container the backend
 * answered, and the SHA-256 of the bootstrap token baked into it (never the
 * token itself). From then on ANY copy can accept the supervisor's first
 * connect, and the copy that does learns the exact container (the session
 * credential is signed over it). Applied only while the sandbox is still
 * `starting` under this runner (204); otherwise 409 and the start stands
 * down, because the sandbox has moved on (deleted, respawned).
 */
export const runnerSpawnRequestSchema = z.object({
  containerRef: containerRefSchema,
  tokenHash: sha256HexSchema,
});
export type RunnerSpawnRequest = z.infer<typeof runnerSpawnRequestSchema>;

/**
 * POST /v1/runner/channels: a copy claims a supervisor's control channel
 * as the socket opens. Two doors, mirroring the socket's own:
 *
 * - `token`: a first connect. Uses the bootstrap token up (single use
 *   across every copy) and answers the sandbox and container it was minted
 *   for.
 * - `session`: a reconnect whose credential the copy has already verified
 *   against `containerRef`. Applied only where that is still the sandbox's
 *   current container and no newer spawn is waiting for its first connect,
 *   so a replaced container can never take the channel back.
 *
 * `connectedAt` (ms since the epoch) orders claims: a claim older than the
 * connection currently holding the channel loses, so a claim retried late
 * can never steal the channel back from a newer socket. 404 on any refusal.
 * Either way the claiming copy becomes the channel's holder, which is what
 * routes the sandbox's channel-bound work to it.
 */
export const runnerChannelClaimRequestSchema = z.discriminatedUnion("door", [
  z.object({
    door: z.literal("token"),
    connectionId: connectionIdSchema,
    connectedAt: z.number().int().nonnegative(),
    tokenHash: sha256HexSchema,
  }),
  z.object({
    door: z.literal("session"),
    connectionId: connectionIdSchema,
    connectedAt: z.number().int().nonnegative(),
    sandboxId: z.string().min(1).max(64),
    containerRef: containerRefSchema,
  }),
]);
export type RunnerChannelClaimRequest = z.infer<
  typeof runnerChannelClaimRequestSchema
>;

export const runnerChannelClaimResponseSchema = z.object({
  sandboxId: z.string().min(1),
  containerRef: containerRefSchema,
});
export type RunnerChannelClaimResponse = z.infer<
  typeof runnerChannelClaimResponseSchema
>;

/**
 * POST /v1/runner/sandboxes/:id/stray-stop: the reconciler claims the
 * stop of a container that still runs although its sandbox is parked:
 * `stopped`/`failed` → `stopping`, only while `containerRef` is still the
 * sandbox's container. 204 claimed, 409 not (a start got there first).
 */
export const runnerStrayStopRequestSchema = z.object({
  containerRef: containerRefSchema,
});
export type RunnerStrayStopRequest = z.infer<
  typeof runnerStrayStopRequestSchema
>;

/**
 * A file materialized into the sandbox before it starts (the gateway CA
 * certificate, credential stubs). Contents are placeholders and public
 * material by law — a real credential here is a critical defect (§3.2).
 */
export const sandboxFileSchema = z.object({
  containerPath: z.string().min(1),
  content: z.string(),
  /** Octal file mode (e.g. 0o600); backend default when absent. */
  mode: z.number().int().optional(),
});
export type SandboxFile = z.infer<typeof sandboxFileSchema>;

/**
 * The spawn payload — composed control-plane-side at dispatch time from
 * current truth (§5.1: the runner is a compute executor, never an API client
 * on the user's behalf), so a re-dispatched start always carries the agent's
 * current proxy token and grant-derived placeholders.
 */
export const sandboxStartPayloadSchema = z.object({
  env: z.record(z.string(), z.string()),
  files: z.array(sandboxFileSchema),
  /**
   * The workspace the sandbox's agent lives in. Namespaced backends fence
   * every sandbox inside its workspace and need this at create
   * time; the Docker backend ignores it. Optional so an older control plane
   * keeps working against a newer runner — a backend that REQUIRES it refuses
   * loudly instead of guessing.
   */
  workspaceId: z.string().min(1).optional(),
  /**
   * The PROVIDER's model id the agent runs (§3.10) — `claude-sonnet-4-6`, not
   * a harness alias. The adapter translates; nothing above it knows which
   * harness will run this.
   */
  model: z.string().optional(),
  /** How hard to think, on our scale. Absent = the provider's own default. */
  effort: z.enum(AGENT_EFFORTS).optional(),
  /** Harness adapter id for the supervisor's composition root. */
  harness: z.string().optional(),
  /** The agent's brief (§3.11), delivered to the supervisor's renderer. */
  instructions: z.string().optional(),
  /** The agent's display name — the identity the rendered instructions give
   * it, so it never falls back on the harness's own self-description. */
  agentName: z.string().optional(),
  /**
   * The agent's channel presences (its own Slack app, later others) for the
   * supervisor's `channels` capability — the section that tells the agent
   * where it can be reached and gates the messaging tools. Composed at
   * dispatch from current truth like everything else here. Optional so an
   * older control plane keeps working against a newer runner; absent reads
   * as "no presences".
   */
  channels: z
    .array(agentChannelPresenceSchema)
    .max(MAX_AGENT_CHANNEL_PRESENCES)
    .optional(),
  /** The peer agents this agent may message (PR 5b), for the supervisor's
   * `agents` capability. Same optionality rule as `channels`. */
  peers: z.array(agentPeerSchema).max(MAX_AGENT_PEERS).optional(),
  /** The agent's attached app connections (and each host-bound app's bound
   * host), for the supervisor's `connections` capability. Same optionality
   * rule as `channels`. */
  connections: z
    .array(agentConnectionSchema)
    .max(MAX_AGENT_CONNECTIONS)
    .optional(),
  /**
   * The preview shares to bring back on THIS boot, present only when a
   * preview hit woke the sandbox (the control plane composes it from the
   * agent's live shares that carry a start command). Absent on every other
   * wake, so a message or a schedule never starts an app. Same optionality
   * rule as `channels`.
   */
  previewRelaunch: z
    .array(previewRelaunchSchema)
    .max(MAX_PREVIEW_RELAUNCHES)
    .optional(),
  /** Provision-time warnings (§7 invariant 5) — surfaced, never swallowed. */
  warnings: z.array(z.string()),
});
export type SandboxStartPayload = z.infer<typeof sandboxStartPayloadSchema>;

/**
 * Ceiling on one `turn.events` batch, serialized. Generous — a coalesced batch
 * of real conversation is a few KB — but finite, which is the point: the
 * strings inside carry model output, and they become rows.
 */
export const MAX_EVENT_BATCH_CHARS = 1_000_000;

export const runnerWorkItemSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("sandbox.start"),
      sandboxId: z.string().min(1),
      agentId: z.string().min(1),
      payload: sandboxStartPayloadSchema,
    }),
    z.object({
      kind: z.literal("sandbox.stop"),
      sandboxId: z.string().min(1),
      /** The container to stop, when the control plane knows it. */
      containerRef: z.string().optional(),
    }),
    /**
     * Deliver a turn into a running sandbox. The runner forwards this over the
     * control channel it already holds and returns immediately — a turn can run
     * for minutes, and the poll loop must not be held by one.
     */
    z.object({
      kind: z.literal("turn.deliver"),
      sandboxId: z.string().min(1),
      conversationId: z.string().min(1),
      turnId: z.string().min(1),
      /** Bounded: this is user-authored text that crosses two hops. */
      message: z.string().max(100_000),
      resumeSessionRef: z.string().max(500).optional(),
      /** Delivery-only prompt context (step 8) — see the transport schema's
       * field of the same name; the runner forwards it verbatim. */
      context: z.string().max(MAX_TURN_CONTEXT_CHARS).optional(),
      /** The turn's user attachments. Sent only to runners that advertised
       * `capabilities.attachments`. */
      attachments: messageAttachmentsSchema,
    }),
    z.object({
      kind: z.literal("turn.abort"),
      sandboxId: z.string().min(1),
      conversationId: z.string().min(1),
      turnId: z.string().min(1),
    }),
    /**
     * Steer a mid-run follow-up into the target turn's live run. Forwarded
     * over the control channel like `turn.abort`; a runner with no live
     * channel does NOTHING (the target turn will strand-fail and the control
     * plane promotes the follow-up — a synthetic report here would be a lie
     * about a sandbox that may just be reconnecting). Only sent to runners
     * that advertised `steerMessages`.
     */
    z.object({
      kind: z.literal("turn.message"),
      sandboxId: z.string().min(1),
      conversationId: z.string().min(1),
      /** The follow-up row's own id — the outcome's correlation key. */
      turnId: z.string().min(1),
      /** The active turn it steers into. */
      targetTurnId: z.string().min(1),
      /** Bounded: user-authored text that crosses two hops. */
      message: z.string().max(100_000),
      /** Delivery-only prompt context (the "a new message arrived" frame
       * for a sender's follow-up, then the note naming where its files
       * landed); see the transport schema's field of the same name. The
       * runner forwards it verbatim. */
      context: z.string().max(MAX_TURN_CONTEXT_CHARS).optional(),
      /** The follow-up's own attachments, pulled ahead of the frame exactly
       * like a turn's. Sent only to runners that advertised
       * `capabilities.steerAttachments`. */
      attachments: messageAttachmentsSchema,
    }),
    /**
     * SEND NOW: the person asked the agent to read a waiting
     * follow-up NOW instead of after the tool it is running. The supervisor
     * moves that tool to the background, so the harness reaches its next
     * safe point and injects the queued message. Claimed only once the
     * follow-up was delivered to this run, so it always follows its own
     * `turn.message` on the same ordered channel. A runner with no live
     * channel does nothing: the request was a wish about a live run, and
     * there is none to act on. Only sent to runners that advertised
     * `sendNow`.
     */
    z.object({
      kind: z.literal("turn.send_now"),
      sandboxId: z.string().min(1),
      conversationId: z.string().min(1),
      /** The follow-up row's own id: the one the person is waiting on. */
      turnId: z.string().min(1),
      /** The running turn it was delivered into. */
      targetTurnId: z.string().min(1),
    }),
    /**
     * Push the home projection into a RUNNING sandbox (step 9). All parts
     * of one generation travel inside ONE work item — the HTTP poll is the
     * unbounded hop, and the runner fanning the parts out serially on one
     * socket is what guarantees their order (and sync-before-turn within a
     * batch). Each part's projected supervisor frame is byte-bounded at the
     * sender; the refine below is the control plane refusing to take its own
     * packer's word for it.
     */
    z.object({
      kind: z.literal("skills.changed"),
      sandboxId: z.string().min(1),
      generation: z.number().int().positive(),
      parts: z
        .array(
          z.object({
            files: z.array(homeSyncFileSchema),
            prune: z.array(homeRelativePathSchema).optional(),
            instructions: z.string().optional(),
            agentName: z.string().optional(),
            /** Final part only, like the two above — see the transport frame
             * for the empty-vs-omitted rule. */
            channels: z
              .array(agentChannelPresenceSchema)
              .max(MAX_AGENT_CHANNEL_PRESENCES)
              .optional(),
            peers: z.array(agentPeerSchema).max(MAX_AGENT_PEERS).optional(),
            connections: z
              .array(agentConnectionSchema)
              .max(MAX_AGENT_CONNECTIONS)
              .optional(),
          }),
        )
        .min(1)
        .max(MAX_SYNC_PARTS),
    }),
    /**
     * Desktop control: a person took or gave back control of a RUNNING
     * sandbox's screen. Forwarded by the runner as the supervisor's
     * `desktop.control` frame, nothing more: the runner is a pass-through
     * and holds no desktop state. Idempotent on the far end, so a
     * re-dispatch after a poll hiccup is inert.
     */
    z.object({
      kind: z.literal("desktop.control"),
      sandboxId: z.string().min(1),
      controlled: z.boolean(),
      controllerName: z
        .string()
        .max(MAX_DESKTOP_CONTROLLER_NAME_CHARS)
        .optional(),
    }),
  ])
  .superRefine((item, ctx) => {
    if (item.kind !== "skills.changed") return;
    for (const [index, part] of item.parts.entries()) {
      const frame = {
        kind: "skills.changed",
        generation: item.generation,
        part: index + 1,
        of: item.parts.length,
        ...part,
      };
      if (syncFrameByteLength(frame) > MAX_SYNC_PART_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sync part ${index + 1} exceeds ${MAX_SYNC_PART_BYTES} bytes`,
        });
      }
    }
  });
export type RunnerWorkItem = z.infer<typeof runnerWorkItemSchema>;

export const runnerWorkRequestSchema = z.object({
  /** Seconds to hold the poll when nothing is due (0 = return at once). */
  wait: z.number().int().min(0).max(25).optional(),
  /** Max items to claim in one poll. */
  limit: z.number().int().min(1).max(10).optional(),
});
export type RunnerWorkRequest = z.infer<typeof runnerWorkRequestSchema>;

export const runnerWorkResponseSchema = z.object({
  items: z.array(runnerWorkItemSchema),
});
export type RunnerWorkResponse = z.infer<typeof runnerWorkResponseSchema>;

/**
 * Lifecycle events the runner reports back. `sandbox.status` carries actual
 * container state (plus refs as they become known — `starting` is the
 * progress event that delivers `containerRef`/`homeRef`); the happy-path
 * transition to `running` is `supervisor.ready`, posted when the sandbox's
 * supervisor opens its channel — a started container whose supervisor never
 * comes up is still not "running".
 */
export const runnerEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sandbox.status"),
    sandboxId: z.string().min(1),
    status: z.enum(["starting", "running", "stopped", "failed"]),
    // Bounded: these are runner-supplied and land in the database and the logs.
    containerRef: z.string().max(200).optional(),
    homeRef: z.string().max(200).optional(),
    error: z.string().max(2000).optional(),
    /**
     * Why a start failed, classified by the runner (see `failure-codes.ts`).
     * Open bounded string, not an enum — the control plane maps known values
     * through an allowlist and treats anything else as the generic
     * `start_failed`, so a newer runner's vocabulary can never invalidate an
     * event batch. Additive-optional: an old control plane strips it.
     */
    reasonCode: z.string().max(64).optional(),
    /**
     * The container this report is about, when it describes something the
     * runner OBSERVED of one container (reconcile seeing it dead, vanished or
     * channelless). The status then applies only while that is still the
     * sandbox's container, so an observation made just before another copy
     * started a fresh container can never knock the fresh one down.
     */
    observedContainerRef: containerRefSchema.optional(),
  }),
  z.object({
    kind: z.literal("supervisor.ready"),
    sandboxId: z.string().min(1),
  }),
  /**
   * A home generation fully applied (step 9). The runner stamps
   * sandboxId from the AUTHENTICATED channel, never the supervisor's
   * payload; the control plane's `lt`-guarded update makes duplicates,
   * stale acks, and cross-runner forgeries inert.
   */
  z.object({
    kind: z.literal("home.synced"),
    sandboxId: z.string().min(1),
    generation: z.number().int().positive(),
  }),
  /**
   * One background process's state (step 10), carrying the runner's TWO
   * stamped facts: `sandboxId` from the authenticated channel and
   * `containerRef` from the runner's own spawn-time map — the third
   * authenticated fact, what lets the control plane tell a live process from
   * a stale row off a dead container. Neither is ever taken from the
   * supervisor's payload.
   */
  z.object({
    kind: z.literal("process.state"),
    sandboxId: z.string().min(1),
    containerRef: z.string().min(1).max(200),
    process: processStateSchema,
  }),
  /**
   * Port discovery (plans/sandbox-ports.md §7): the guest's listening TCP
   * ports, forwarded from the supervisor's `ports.state` with the same two
   * stamped facts as `process.state`. The control plane keeps the latest set
   * on the sandbox row, so the dashboard's Ports section reads it from the
   * DB in every edition (the api never dials a runner for it).
   */
  z.object({
    kind: z.literal("sandbox.ports"),
    sandboxId: z.string().min(1),
    containerRef: z.string().min(1).max(200),
    ports: listeningPortsSchema,
  }),
  /**
   * Desktop presence: whether the sandbox's screen can be watched,
   * forwarded from the supervisor's `desktop.state` with the same two
   * stamped facts. The control plane keeps it on the sandbox row.
   */
  z.object({
    kind: z.literal("sandbox.desktop"),
    sandboxId: z.string().min(1),
    containerRef: z.string().min(1).max(200),
    viewable: z.boolean(),
  }),
  /**
   * Canonical agent events from a turn, already coalesced by the runner (the
   * delta law, §3.17). Every event here reaches live subscribers; only the
   * bounded kinds become durable rows.
   */
  z.object({
    kind: z.literal("turn.events"),
    /**
     * WHICH SANDBOX IS SPEAKING — stamped by the runner from the authenticated
     * control channel, never copied out of the supervisor's message. The
     * conversation and turn ids below ARE supervisor-chosen, and a sandbox
     * runs model-driven code, so this is what stops one sandbox reporting
     * turns for a conversation that is not its agent's.
     */
    sandboxId: z.string().min(1),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    events: z
      .array(agentEventSchema)
      .min(1)
      .max(100)
      // Bounded by SIZE as well as count, because the count alone is not a
      // bound: an event's strings carry model output (a `tool.finished`
      // holding the contents of whatever the agent just read), and those land
      // in `turn_events.payload`. 100 unbounded events is an unbounded write.
      // The runner truncates and splits to stay well under this (see
      // apps/runner/src/turn-events.ts); the cap here is the control plane
      // refusing to take the DB's word for it.
      .refine(
        (events) => JSON.stringify(events).length <= MAX_EVENT_BATCH_CHARS,
        `a turn.events batch may not exceed ${MAX_EVENT_BATCH_CHARS} characters`,
      ),
  }),
  /**
   * The supervisor's turn-liveness heartbeat, relayed as its own single-event
   * post (never batched with transcript events — an old control plane
   * rejecting the unknown kind must lose only heartbeats). It carries no
   * payload beyond identity: arriving at all is the signal, and the control
   * plane stamps `turns.last_progress_at` from its own clock.
   */
  z.object({
    kind: z.literal("turn.progress"),
    /** As above: the authenticated speaker, not a claim in the payload. */
    sandboxId: z.string().min(1),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
  }),
  /**
   * A turn reached a terminal state. `sessionRef` rides along because the
   * conversation's harness session is only knowable inside the sandbox.
   */
  z.object({
    kind: z.literal("turn.finished"),
    /** As above: the authenticated speaker, not a claim in the payload. */
    sandboxId: z.string().min(1),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.enum(["done", "failed", "aborted"]),
    error: z.string().max(2000).optional(),
    /** Forwarded verbatim from `turn.result.errorCode` (see the transport
     * schema's field doc) — the control plane's allowlist owns the meaning.
     * Additive-optional: an old control plane strips it. */
    errorCode: z.string().max(64).optional(),
    usage: turnUsageSchema.optional(),
    sessionRef: z.string().max(500).optional(),
    /** Per-follow-up steer outcomes, forwarded verbatim from `turn.result`
     * (see the transport schema's field). An old control plane strips it —
     * every follow-up then promotes, the queue-only degrade. */
    followUps: z
      .array(
        z.object({
          turnId: z.string().min(1),
          outcome: z.enum(["joined", "missed"]),
        }),
      )
      .max(16)
      .optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/**
 * Ceiling on one events POST. The runner's client chunks larger batches into
 * sequential posts at this bound — a reconcile pass over a big fleet (a dead
 * node's worth of corrective events) must degrade to more requests, never to
 * one 400 that loses the whole report.
 */
export const MAX_RUNNER_EVENTS_PER_POST = 100;

export const runnerEventsRequestSchema = z.object({
  events: z.array(runnerEventSchema).min(1).max(MAX_RUNNER_EVENTS_PER_POST),
});
export type RunnerEventsRequest = z.infer<typeof runnerEventsRequestSchema>;

/**
 * GET /runner/sandboxes/:id/ports — the sandbox's live shared ports, the ONE
 * source a runner arms its port allowlist from (plans/sandbox-ports.md). The
 * preview relay can only ask the runner to refresh; it never names ports.
 */
export const runnerSandboxPortsResponseSchema = z.object({
  ports: z.array(z.number().int().min(1).max(65_535)).max(64),
});

/**
 * One sandbox's channel facts in the reconcile listing. `channel` is an open
 * string, never an enum, like `statuses`: a reader treats a value it does not
 * know as `none`. The known values:
 *
 * - `starting`: a start is under way and has not recorded its spawn yet.
 * - `awaiting`: the spawn is recorded and its supervisor has not connected;
 *   `since` is when the spawn was recorded.
 * - `held`: a live copy holds the socket; `since` is when it connected.
 * - `dropped`: a copy saw the socket close and nothing has reclaimed it;
 *   `since` is when.
 * - `lost`: the copy holding it retired or stopped heartbeating; `since` is
 *   when it retired, else its last heartbeat.
 * - `none`: nothing recorded (a container from before channel records).
 *
 * `since` is milliseconds since the epoch.
 */
export const RUNNER_CHANNEL_STATES = [
  "starting",
  "awaiting",
  "held",
  "dropped",
  "lost",
  "none",
] as const;
export type RunnerChannelState = (typeof RUNNER_CHANNEL_STATES)[number];

export const runnerSandboxChannelSchema = z.object({
  containerRef: z.string().min(1).nullable(),
  channel: z.string().min(1),
  since: z.number().int().nullable(),
});
export type RunnerSandboxChannel = z.infer<typeof runnerSandboxChannelSchema>;

/**
 * The reconcile truth. Validated like everything else on this wire — and it
 * matters most here: the runner destroys every container and home absent
 * from this list, so a wrong-shaped 200 (a misdirected URL, a proxy error
 * page) must fail loudly rather than coerce to "host nothing".
 */
export const runnerSandboxesResponseSchema = z.object({
  sandboxIds: z.array(z.string().min(1)),
  /**
   * What the control plane currently BELIEVES about each assigned sandbox,
   * keyed by sandbox id — the vanished-pod arm's input: a sandbox believed
   * `running` with no backend snapshot is a sandbox that died out-of-band, and
   * the runner is the only party positioned to notice. `sandboxIds` stays
   * the reap authority; this field is advisory. Values ride as open strings
   * (never an enum — a future status must not break an old runner's parse),
   * and the whole field is additive-optional so a new runner tolerates an
   * old control plane by leaving the arm inert.
   */
  statuses: z.record(z.string().min(1), z.string().min(1)).optional(),
  /**
   * Per assigned sandbox, what the control plane knows of its current
   * container and control channel: the reconciler's input for telling a
   * sandbox that is booting or reconnecting from one that is gone, whichever
   * copy holds (or held) its socket. Answered to runners that name their copy.
   */
  channels: z.record(z.string().min(1), runnerSandboxChannelSchema).optional(),
  /**
   * Whether the calling copy is the runner's reconciler: the oldest live
   * copy. Only the reconciler classifies containers and reaps orphans, so N
   * copies never report or destroy the same thing N times. Answered to
   * runners that name their copy; a single-process runner always reconciles.
   */
  reconciler: z.boolean().optional(),
});
export type RunnerSandboxesResponse = z.infer<
  typeof runnerSandboxesResponseSchema
>;

/**
 * `GET /v1/runner/replicas/self`: the calling copy's reconciler role on its
 * own, the same rule as the listing's `reconciler`. Every copy asks each
 * reconcile pass, and only the reconciler then fetches the full listing:
 * the others would pay for every sandbox's row just to learn they need none
 * of it. Answered to runners that name their copy (404 otherwise).
 */
export const runnerReplicaSelfResponseSchema = z.object({
  reconciler: z.boolean(),
});
export type RunnerReplicaSelfResponse = z.infer<
  typeof runnerReplicaSelfResponseSchema
>;

/**
 * The orphan sweep's authority check (step 13): which of these sandbox ids
 * exist NOWHERE in the control plane — any runner's, deliberately, because a
 * stale-label orphan is by definition not the caller's. Bounded so a
 * pathological daemon cannot turn the sweep into an unbounded query.
 */
export const MAX_SANDBOX_CHECK_IDS = 500;

export const runnerSandboxCheckRequestSchema = z.object({
  // Real sandbox ids are uuids; .max(64) is cheap defense-in-depth so a
  // holder of a valid rnr_ token cannot ship 500 multi-MB strings at the
  // findMany behind this endpoint.
  sandboxIds: z.array(z.string().min(1).max(64)).max(MAX_SANDBOX_CHECK_IDS),
});
export type RunnerSandboxCheckRequest = z.infer<
  typeof runnerSandboxCheckRequestSchema
>;

/** Validated runner-side like the sandboxes list: this answer decides what
 * the sweep DESTROYS, so a wrong shape must throw, never coerce. */
export const runnerSandboxCheckResponseSchema = z.object({
  missing: z.array(z.string().min(1)),
});
export type RunnerSandboxCheckResponse = z.infer<
  typeof runnerSandboxCheckResponseSchema
>;

export const runnerHeartbeatRequestSchema = z.object({
  capabilities: runnerCapabilitiesSchema.optional(),
});
export type RunnerHeartbeatRequest = z.infer<
  typeof runnerHeartbeatRequestSchema
>;

/**
 * POST /v1/runner/tool-call (step 7) — the runner relaying a platform-tool
 * invocation from a sandbox it hosts. `sandboxId` is stamped by the runner
 * from the AUTHENTICATED control channel, never copied from the supervisor's
 * payload (the ws-server law: a supervisor can only ever speak for itself),
 * and the control plane re-fences it against the runner's token — the
 * two-fact identity every sandbox-originated write uses.
 */
export const runnerToolCallRequestSchema = z.object({
  sandboxId: z.string().min(1),
  tool: z.string().min(1).max(100),
  args: z.unknown(),
  /** The calling turn, when the invocation happened inside one — context for
   * anchoring (a schedule's origin conversation), verified server-side. */
  conversationId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
});
export type RunnerToolCallRequest = z.infer<typeof runnerToolCallRequestSchema>;

/** `ok:false` is a TOOL error (the model reads it and can react); transport
 * failures never produce this shape — they surface as the correlator's
 * timeout error at the supervisor. */
export const runnerToolCallResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type RunnerToolCallResponse = z.infer<
  typeof runnerToolCallResponseSchema
>;

/**
 * POST /v1/runner/memory-write — the runner relaying a harvested memory-file
 * write from a sandbox it hosts (the projection's write-back half).
 * `sandboxId` follows the tool-call law exactly: stamped from the
 * AUTHENTICATED channel, never the supervisor's payload, re-fenced against
 * the runner token server-side. The superRefine is the wire's byte belt —
 * the harvester (sender) enforces the same budget first.
 */
export const runnerMemoryWriteRequestSchema = z
  .object({
    sandboxId: z.string().min(1),
    key: z.string().min(1).max(MEMORY_KEY_MAX_LENGTH).regex(MEMORY_KEY_PATTERN),
    content: z.string().min(1).max(MEMORY_FILE_CONTENT_MAX_CHARS),
    title: z.string().max(MEMORY_TITLE_MAX_LENGTH).optional(),
    description: z.string().max(MEMORY_DESCRIPTION_MAX_LENGTH).optional(),
    /** The active turn when the file write was observed — anchoring for
     * provenance/audit, verified server-side, never authority. */
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  })
  .superRefine((request, ctx) => {
    if (syncFrameByteLength(request) > MAX_MEMORY_WRITE_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `memory write exceeds ${MAX_MEMORY_WRITE_BYTES} serialized bytes`,
      });
    }
  });
export type RunnerMemoryWriteRequest = z.infer<
  typeof runnerMemoryWriteRequestSchema
>;

/** Mirrors the supervisor-facing `memory.write.result` fields (minus the
 * correlation id, which never leaves the runner). */
export const runnerMemoryWriteResponseSchema = z.object({
  ok: z.boolean(),
  created: z.boolean().optional(),
  revisionSeq: z.number().int().positive().optional(),
  noop: z.boolean().optional(),
  retryable: z.boolean().optional(),
  error: z.string().optional(),
});
export type RunnerMemoryWriteResponse = z.infer<
  typeof runnerMemoryWriteResponseSchema
>;

/**
 * POST /v1/runner/attachments — the runner relaying a file the agent is
 * sending back (`send_file`, Tier 3). The BODY is the raw bytes (the web
 * upload door's precedent: this repo has no multipart anywhere, and a raw
 * body lets the api stream-cap with `readCappedBinaryBody` instead of
 * buffering a form). The metadata rides HEADERS, named here so both ends
 * spell them once. `sandboxId` follows the tool-call law: stamped by the
 * runner from the AUTHENTICATED channel, never the supervisor's payload,
 * re-fenced against the runner token server-side; the turn must be live
 * under the fenced agent's conversation. Caps live in attachments.ts and are
 * enforced by the api regardless of what the headers claim.
 */
export const RUNNER_ATTACHMENT_HEADERS = {
  sandboxId: "x-onecli-sandbox-id",
  conversationId: "x-onecli-conversation-id",
  turnId: "x-onecli-turn-id",
  name: "x-onecli-file-name",
  sha256: "x-onecli-file-sha256",
  caption: "x-onecli-file-caption",
} as const;

/** The header set, parsed. `name` and `caption` are percent-encoded on the
 * wire (HTTP header values are Latin-1; a file name is not). */
export const runnerAttachmentUploadHeadersSchema = z.object({
  sandboxId: z.string().min(1),
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  name: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  caption: z.string().max(MAX_OUTBOUND_CAPTION_CHARS).optional(),
});
export type RunnerAttachmentUploadHeaders = z.infer<
  typeof runnerAttachmentUploadHeadersSchema
>;

/** Mirrors the supervisor-facing `file.result` (minus the correlation id). A
 * parseable request ALWAYS answers this shape with 200 — caps, fence misses
 * and bad bytes are `ok:false` the model reads, never status-code oracles.
 * The one exception is the body cap: an oversized body is cut mid-stream and
 * answered 413, because the api will not read 25 MB to say no. */
export const runnerAttachmentUploadResponseSchema = z.object({
  ok: z.boolean(),
  attachmentId: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  error: z.string().optional(),
});
export type RunnerAttachmentUploadResponse = z.infer<
  typeof runnerAttachmentUploadResponseSchema
>;
