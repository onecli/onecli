import { z } from "zod";
import { agentEventSchema, turnUsageSchema } from "./events";
import {
  MAX_MEMORY_WRITE_BYTES,
  MEMORY_DESCRIPTION_MAX_LENGTH,
  MEMORY_FILE_CONTENT_MAX_CHARS,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  MEMORY_TITLE_MAX_LENGTH,
} from "./memory-file";

/**
 * The supervisor's transport seam (§3.17 house pattern): how work reaches the
 * supervisor and events leave it. Step 2 ships the stdio driver (JSONL over
 * stdin/stdout — what `docker run -i` and the dev loop drive); step 3 adds
 * the WebSocket driver that dials the runner. The vocabulary is shared so the
 * swap never touches the supervisor loop.
 */

/**
 * Bounds for the platform-tool RPC (step 7), applied at the SENDER on both
 * ends — the runner's WS frames cap at 256KB and an oversized message is
 * dropped whole, which for an RPC means a caller waiting out its timeout for
 * an answer that validation already discarded. Same law as
 * MAX_UNHEALTHY_REASON_CHARS below: truncate at the source, never let your
 * own signal be the thing your validation rejects.
 */
export const MAX_TOOL_ARGS_CHARS = 32_000;
export const MAX_TOOL_RESULT_CHARS = 64_000;
export const MAX_TOOL_ERROR_CHARS = 2_000;

/**
 * Bound for a turn's delivery-only context prepend (step 8: the memory index
 * and confident-retrieval snippets). Its own cap, far below the message's
 * 100k, because it is a recurring per-turn token cost — the builder holds it
 * by construction and hard-slices as the last resort (truncate at the
 * sender, same law as the tool bounds above).
 */
export const MAX_TURN_CONTEXT_CHARS = 16_000;

// The sync byte budget lives in sync-budget.ts (a leaf module — memory-file
// needs it too, and transport imports memory-file's caps; see its header).
// Imported for local use (the memory.write byte belt below) AND re-exported
// so every existing import path keeps working.
import {
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  syncFrameByteLength,
} from "./sync-budget";
export { MAX_SYNC_PART_BYTES, MAX_SYNC_PARTS, syncFrameByteLength };

import {
  ATTACHMENT_CHUNK_BASE64_CHARS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_CHARS,
} from "./attachments";

/**
 * Bounds for background-process state frames (step 10). Every string is
 * truncated at the SENDER (the manager's frame builder) — the standing law.
 * The 64k tail ring stays supervisor-local; only a 1k excerpt ever rides the
 * wire. Worst-case frame ≈ 29k chars, comfortably under the 256KB ws cap.
 */
export const MAX_PROCESS_COMMAND_CHARS = 2_000;
export const MAX_PROCESS_NAME_CHARS = 100;
export const MAX_PROCESS_TAIL_WIRE_CHARS = 1_000;
export const MAX_WATCH_PATTERN_CHARS = 200;
export const MAX_WATCH_PROMPT_CHARS = 2_000;
export const MAX_WATCH_EXCERPT_CHARS = 1_000;
/** Wire headroom over the product cap (3 armed) for terminal retention. */
export const MAX_WATCHES_PER_PROCESS_WIRE = 8;

/**
 * One process's whole reported state, including its watches — the unit of
 * the step-10 reliability design: re-sent unconditionally (~30s) because a
 * supervisor can never reconnect (single-use ws token), so "re-send on
 * reconnect" is a dead letter; duplicates are inert at the control plane
 * (transition-guarded upserts, the home.synced re-ack law generalized).
 * `lost` and `fired` never appear here — they are control-plane-authored.
 */
export const processStateSchema = z.object({
  /** Supervisor-chosen per-boot id; the control plane keys rows on
   * (sandboxId, ref), so a forged ref cannot cross a tenant boundary. */
  ref: z.string().min(1).max(100),
  command: z.string().max(MAX_PROCESS_COMMAND_CHARS),
  name: z.string().max(MAX_PROCESS_NAME_CHARS).optional(),
  status: z.enum(["running", "exited", "stopped"]),
  exitCode: z.number().int().optional(),
  signal: z.string().max(20).optional(),
  /** ISO timestamps on the supervisor clock. */
  startedAt: z.string().max(40),
  endedAt: z.string().max(40).optional(),
  tail: z.string().max(MAX_PROCESS_TAIL_WIRE_CHARS).optional(),
  /** Arm-time turn context — anchoring, not authority (the crons doctrine). */
  conversationId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  watches: z
    .array(
      z.object({
        ref: z.string().min(1).max(100),
        kind: z.enum(["exit", "pattern", "silence"]),
        pattern: z.string().max(MAX_WATCH_PATTERN_CHARS).optional(),
        silenceSeconds: z.number().int().positive().optional(),
        prompt: z.string().max(MAX_WATCH_PROMPT_CHARS),
        status: z.enum(["armed", "triggered", "expired", "canceled"]),
        trigger: z.enum(["exited", "matched", "silent"]).optional(),
        excerpt: z.string().max(MAX_WATCH_EXCERPT_CHARS).optional(),
        triggeredAt: z.string().max(40).optional(),
        expiresAt: z.string().max(40),
        conversationId: z.string().min(1).optional(),
        turnId: z.string().min(1).optional(),
      }),
    )
    .max(MAX_WATCHES_PER_PROCESS_WIRE),
});
export type ProcessState = z.infer<typeof processStateSchema>;

/**
 * A home-relative path on the sync wire. Traversal is unrepresentable
 * by refinement — the containment defense's first line; the supervisor's
 * materializer re-verifies managed-root membership as the second.
 */
export const homeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
    "home-relative path with no traversal",
  );

export const homeSyncFileSchema = z.object({
  path: homeRelativePathSchema,
  content: z.string(),
});
export type HomeSyncFile = z.infer<typeof homeSyncFileSchema>;

/**
 * One user attachment's metadata as the wire speaks it — carried on
 * `turn.deliver` (the manifest: what THIS turn's message attached, where it
 * lands, how to verify it) and echoed field-for-field by every
 * `attachment.part` frame so the applier needs no cross-frame state beyond
 * the byte buffer. `sha256` is an integrity check on a lossy multi-hop pipe,
 * not a trust boundary — the bytes already crossed the authenticated runner
 * channel.
 */
export const attachmentManifestEntrySchema = z.object({
  id: z.string().min(1).max(100),
  path: homeRelativePathSchema,
  name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AttachmentManifestEntry = z.infer<
  typeof attachmentManifestEntrySchema
>;

export const workItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn.deliver"),
    /** Opaque turn identity, echoed on every resulting message. */
    turnId: z.string().min(1),
    /**
     * Which conversation this turn belongs to. The supervisor keeps one
     * harness session per conversation (§3.6), so this is what decides which
     * context the message lands in.
     */
    conversationId: z.string().min(1),
    /**
     * The conversation's harness session, when it has one. Absent on its very
     * first turn; present afterwards so the session is resumed rather than
     * restarted (`startSession({ resumeSessionRef })`).
     */
    resumeSessionRef: z.string().optional(),
    message: z.string(),
    /**
     * Delivery-only prompt context (step 8: the memory index + snippets),
     * prepended by the supervisor when handing the harness the message —
     * NEVER stored in the transcript, so the wire stays honest about what
     * the human wrote vs what the platform framed. A stale supervisor's
     * non-strict parse silently drops it: the desired degrade.
     */
    context: z.string().max(MAX_TURN_CONTEXT_CHARS).optional(),
    /**
     * The turn's user attachments, metadata only — the bytes arrived ahead
     * of this frame as `attachment.part`s on the same ordered socket. The
     * supervisor uses it to pick inline-vision images off the disk; an OLD
     * supervisor image strips the unknown field (non-strict parse) and the
     * files simply sit on disk for the read tool — the desired degrade.
     */
    attachments: z.array(attachmentManifestEntrySchema).optional(),
  }),
  z.object({
    kind: z.literal("turn.abort"),
    turnId: z.string().min(1),
    conversationId: z.string().min(1),
  }),
  /**
   * A mid-run FOLLOW-UP message: steer it into the target turn's live run at
   * the harness's next safe point. `turnId` is the follow-up's OWN id (the
   * correlation the outcome reports under); `targetTurnId` is the running
   * turn it joins. An OLD supervisor image drops this on schema validation —
   * the desired degrade: the control plane promotes the undelivered
   * follow-up into an ordinary queued turn.
   */
  z.object({
    kind: z.literal("turn.message"),
    turnId: z.string().min(1),
    targetTurnId: z.string().min(1),
    conversationId: z.string().min(1),
    message: z.string(),
  }),
  /**
   * One chunk of one user attachment's bytes, sent by the runner BEFORE the
   * `turn.deliver` frame it belongs to (same ordered socket — that ordering,
   * plus the sync-queue apply, is the whole delivery guarantee). Fields echo
   * the manifest entry so the applier keeps no cross-frame state beyond the
   * byte buffer; `dataBase64` is bounded so a legal frame can never hit the
   * WS's silent 256KB drop (truncate-at-sender law — the runner chunks at
   * ATTACHMENT_CHUNK_RAW_BYTES, this is the wire refusing to take its word).
   * An OLD supervisor image drops the frame on schema validation — files
   * absent, read tool fails honestly; named degrade.
   */
  z.object({
    kind: z.literal("attachment.part"),
    turnId: z.string().min(1),
    attachmentId: z.string().min(1).max(100),
    path: homeRelativePathSchema,
    name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS),
    mimeType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    part: z.number().int().positive(),
    of: z.number().int().positive(),
    dataBase64: z
      .string()
      .min(1)
      .max(ATTACHMENT_CHUNK_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
  /**
   * The answer to a `tool.call` (step 7). An OLD supervisor image receiving
   * this drops it on schema validation, which is exactly right — it has no
   * pending call to resolve. Serialized `result` is bounded by the runner
   * (MAX_TOOL_RESULT_CHARS) before sending.
   */
  z.object({
    kind: z.literal("tool.result"),
    callId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(MAX_TOOL_ERROR_CHARS).optional(),
  }),
  /**
   * One part of a home sync (step 9): skills + memory projection files,
   * pushed live. Parts of one generation arrive in order on this socket; the
   * FINAL part (part === of) additionally carries the prune manifest and the
   * fresh instruction-render inputs. An OLD supervisor image drops the arm on
   * schema validation — the desired degrade; the never-arriving ack keeps
   * `applied` behind and the control plane re-pushes on its paced window.
   */
  z.object({
    kind: z.literal("skills.changed"),
    generation: z.number().int().positive(),
    part: z.number().int().positive(),
    of: z.number().int().positive(),
    files: z.array(homeSyncFileSchema),
    /** FINAL part only: the complete desired manifest under the managed
     * roots; everything else found there is pruned. */
    prune: z.array(homeRelativePathSchema).optional(),
    /** FINAL part only: fresh renderer inputs, so a dashboard brief edit
     * re-renders the instruction docs mid-run (§3.11). */
    instructions: z.string().optional(),
    agentName: z.string().optional(),
  }),
  /**
   * The answer to a `memory.write` (the file-harvest upload). Same shape
   * discipline as `tool.result`: correlated by `writeId`, handled inline in
   * the supervisor's reader (a result queued behind a sync apply that is
   * awaiting it would deadlock into the timeout). An OLD supervisor image
   * drops it on schema validation — it sent no `memory.write` to resolve.
   */
  z.object({
    kind: z.literal("memory.write.result"),
    writeId: z.string().min(1),
    ok: z.boolean(),
    /** True when the write created the memory (vs updating). */
    created: z.boolean().optional(),
    revisionSeq: z.number().int().positive().optional(),
    /** True when the platform already held exactly this state — the echo
     * terminator: the harvester records the content as uploaded and stops. */
    noop: z.boolean().optional(),
    /** True when the refusal is transient (rate pacing, transport) — retry
     * paced; false/absent refusals (caps, bad key) wait for a content
     * change. */
    retryable: z.boolean().optional(),
    error: z.string().max(MAX_TOOL_ERROR_CHARS).optional(),
  }),
  z.object({ kind: z.literal("shutdown") }),
]);
export type WorkItem = z.infer<typeof workItemSchema>;

/**
 * Cap on an `unhealthy` report's reason.
 *
 * Exported because the SENDER must apply it too. A reason built from an
 * arbitrary error string can exceed this, and an over-long one does not
 * degrade — it fails validation at the runner, which drops the whole message,
 * which puts the sandbox straight back into the silent brick this report
 * exists to prevent. Truncate at the source; never let your own signal be the
 * thing your validation rejects.
 */
export const MAX_UNHEALTHY_REASON_CHARS = 2000;

/**
 * Cap on a `turn.result` error string, applied at the SENDER (the schema
 * stays open for old peers). Same law as MAX_UNHEALTHY_REASON_CHARS: the
 * terminal frame must deliver, and an unbounded harness error could exceed
 * the runner WS server's frame cap, which does not truncate — it drops the
 * frame and kills the socket, losing the turn's close entirely. Matches the
 * runner's own forward cap (`turn.finished` error, runner-wire.ts), so
 * nothing downstream ever kept more anyway.
 */
export const MAX_TURN_RESULT_ERROR_CHARS = 2000;

export const supervisorMessageSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ready"),
      /** The active adapter id — reporting, never a routing key. */
      harness: z.string(),
    }),
    z.object({
      kind: z.literal("event"),
      turnId: z.string().min(1),
      conversationId: z.string().min(1),
      event: agentEventSchema,
    }),
    /**
     * The turn-liveness heartbeat: sent on a timer (~60s) for the whole life
     * of an in-flight turn, whatever the agent is doing — deliberately NOT an
     * AgentEvent, so it can never land in a transcript, and deliberately its
     * own frame, so an old control plane rejecting the unknown kind poisons
     * nothing but the heartbeat itself (the runner relays it as a single-event
     * post). Silence past the stall window is what fails the turn.
     */
    z.object({
      kind: z.literal("progress"),
      turnId: z.string().min(1),
      conversationId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("turn.result"),
      turnId: z.string().min(1),
      conversationId: z.string().min(1),
      /**
       * How the turn ended, as the OUTCOME rather than a boolean. An abort ends
       * the harness stream cleanly, so "did it finish without throwing" cannot
       * distinguish a completed turn from a cancelled one — and the control
       * plane's `aborted` status would be unreachable for the only path that
       * can actually produce it.
       */
      status: z.enum(["done", "failed", "aborted"]),
      error: z.string().optional(),
      /**
       * Machine-readable failure class (see `failure-codes.ts`), attached
       * beside the raw `error` when the harness itself died — or when a live
       * harness's model provider refused the request. An open bounded
       * string, never an enum: this is the one frame that must deliver, and
       * a novel future code must degrade (the control plane's allowlist
       * ignores it), not invalidate the frame. Additive-optional — an old
       * runner strips it and everything behaves as today.
       */
      errorCode: z.string().max(64).optional(),
      usage: turnUsageSchema.optional(),
      /**
       * The harness session this turn ran in. Carried out so the control plane
       * can persist it on the conversation — nothing else can learn it, and
       * without it every turn would start a fresh context.
       */
      sessionRef: z.string().optional(),
      /**
       * Per-follow-up outcomes for every steer this turn was handed: `joined`
       * = the adapter CONFIRMED the harness consumed it; `missed` = delivered
       * but unconfirmed. Riding the terminal report on purpose — it is the one
       * frame the whole system treats as must-deliver, so the settle and the
       * close arrive (or are lost) together. An old runner strips the field;
       * every follow-up then promotes — the queue-only degrade.
       */
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
    /**
     * A platform-tool invocation (step 7): the agent called an MCP tool the
     * supervisor serves, and the handler lives control-plane-side. Correlated
     * request/response — `callId` pairs it with the runner's `tool.result` —
     * on its OWN awaited path at the runner, never the lossy event-report
     * chain: a dropped event costs a reconnect, a dropped RPC hangs a turn.
     *
     * An OLD runner drops this on schema validation; the supervisor's
     * correlator then times out into a clean tool error the model can read.
     * `conversationId`/`turnId` are the CALLING turn when one is active — the
     * control plane uses them (fenced, never trusted alone) to anchor a
     * schedule's origin; they are context, not authority.
     */
    z.object({
      kind: z.literal("tool.call"),
      callId: z.string().min(1),
      tool: z.string().min(1).max(100),
      args: z.unknown(),
      conversationId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
    }),
    /**
     * A home generation was fully applied (step 9) — sent on the FINAL
     * part after prune + re-render, and RE-SENT on every re-apply (even a
     * no-op repeat): the previous ack may be exactly what was dropped. The
     * control plane's `lt`-guarded update makes duplicates inert.
     */
    z.object({
      kind: z.literal("home.synced"),
      generation: z.number().int().positive(),
    }),
    /**
     * One background process's current state, watches included (step 10).
     * Sent on every change AND re-sent unconditionally on a slow clock — see
     * processStateSchema's header for why re-send is the only reliability
     * mechanism available to a supervisor.
     */
    z.object({
      kind: z.literal("process.state"),
      process: processStateSchema,
    }),
    /**
     * An agent-authored memory file leaving the sandbox (the write-back half
     * of the projection): the harvester found bytes under `memory/` that are
     * not an unmodified projection and is saving them to the platform — the
     * DB stays the single source of truth; the file is the agent's working
     * copy. Correlated request/response like `tool.call`, on the runner's
     * awaited path, never the lossy report chain. Byte-budgeted at the SENDER
     * (the standing law); the union's `superRefine` below is the wire's own
     * belt — char caps alone admit a ~300KB CJK frame the runner WS would
     * drop whole at 256KB, so a non-harvester sender fails validation rather
     * than looping into a silent 25s timeout.
     */
    z.object({
      kind: z.literal("memory.write"),
      writeId: z.string().min(1).max(100),
      key: z
        .string()
        .min(1)
        .max(MEMORY_KEY_MAX_LENGTH)
        .regex(MEMORY_KEY_PATTERN),
      content: z.string().min(1).max(MEMORY_FILE_CONTENT_MAX_CHARS),
      title: z.string().max(MEMORY_TITLE_MAX_LENGTH).optional(),
      description: z.string().max(MEMORY_DESCRIPTION_MAX_LENGTH).optional(),
      /** The active turn when the write was observed — anchoring for
       * provenance (the tool.call doctrine), verified server-side. */
      conversationId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("unhealthy"),
      /**
       * This sandbox can no longer serve turns — its harness is gone and no
       * further session can be started in it.
       *
       * Reported rather than inferred because nothing above the supervisor can
       * see it: the container still runs and the control channel is still open,
       * so the control plane goes on believing the sandbox is healthy and every
       * message fails forever. Saying so lets the ORDINARY recovery run — the
       * runner reports the sandbox stopped, and the next message wakes it into
       * a fresh container.
       */
      reason: z.string().max(MAX_UNHEALTHY_REASON_CHARS),
    }),
  ])
  .superRefine((message, ctx) => {
    // The byte belt for `memory.write` (the runnerWorkItemSchema pattern): a
    // frame over MAX_MEMORY_WRITE_BYTES is refused here rather than dropped
    // silently by the runner WS at 256KB. Applied to the whole union so the
    // discriminated members stay plain ZodObjects.
    if (message.kind !== "memory.write") return;
    if (syncFrameByteLength(message) > MAX_MEMORY_WRITE_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `memory.write exceeds ${MAX_MEMORY_WRITE_BYTES} serialized bytes`,
      });
    }
  });
export type SupervisorMessage = z.infer<typeof supervisorMessageSchema>;

export interface SupervisorTransport {
  /** Work items in arrival order; the iterable ends when the peer closes. */
  incoming(): AsyncIterable<WorkItem>;
  send(message: SupervisorMessage): void;
  /**
   * Release the channel and end `incoming()`.
   *
   * Called once, after the loop has ended and every in-flight turn has
   * reported. That ORDER is what gets the last messages out — a driver is not
   * required to flush anything here, and a driver whose channel is down may
   * legitimately have nothing to flush to. Without this call a supervisor that
   * stops looping keeps an open socket, which keeps Node's event loop alive,
   * which keeps a container running with nothing left to do.
   */
  close(): Promise<void>;
}
