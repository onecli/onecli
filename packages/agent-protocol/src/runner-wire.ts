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
import {
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  MAX_TURN_CONTEXT_CHARS,
  attachmentManifestEntrySchema,
  processStateSchema,
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
   * This runner pulls attachment bytes (`GET /v1/runner/attachments/:id`)
   * and streams them into the sandbox ahead of the turn. Dispatch composes
   * the `turn.deliver` manifest + context note ONLY for capable runners —
   * otherwise the turn ships bare with no note, so the agent is never told
   * about files that cannot arrive. Absent = false.
   */
  attachments: z.boolean().optional(),
});
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

export const runnerRegisterRequestSchema = z.object({
  name: z.string().min(1).max(200),
  capabilities: runnerCapabilitiesSchema,
});
export type RunnerRegisterRequest = z.infer<typeof runnerRegisterRequestSchema>;

export const runnerRegisterResponseSchema = z.object({
  runnerId: z.string().min(1),
});
export type RunnerRegisterResponse = z.infer<
  typeof runnerRegisterResponseSchema
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
   * The workspace the sandbox's agent lives in (step 3 of
   * plans/sandbox-platform.md). Namespaced backends (the cloud manager) fence
   * every sandbox inside its workspace's namespace and need this at create
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
      /**
       * The turn's user attachments, METADATA ONLY — bytes never ride the
       * poll (a claimed batch could otherwise reach hundreds of MB of JSON
       * and one oversized/failed parse would poison every re-dispatch). The
       * runner pulls each attachment's bytes from
       * `GET /v1/runner/attachments/:id`, chunks them into `attachment.part`
       * frames, and only then forwards the turn frame. Sent only to runners
       * that advertised `capabilities.attachments`.
       */
      attachments: z
        .array(attachmentManifestEntrySchema)
        .max(MAX_ATTACHMENTS_PER_MESSAGE)
        .optional(),
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
          }),
        )
        .min(1)
        .max(MAX_SYNC_PARTS),
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
   * `running` with no backend snapshot is a pod that died out-of-band, and
   * the runner is the only party positioned to notice. `sandboxIds` stays
   * the reap authority; this field is advisory. Values ride as open strings
   * (never an enum — a future status must not break an old runner's parse),
   * and the whole field is additive-optional so a new runner tolerates an
   * old control plane by leaving the arm inert.
   */
  statuses: z.record(z.string().min(1), z.string().min(1)).optional(),
});
export type RunnerSandboxesResponse = z.infer<
  typeof runnerSandboxesResponseSchema
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
