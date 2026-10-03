import { createHash } from "node:crypto";
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_TOOL_ERROR_CHARS,
  MAX_TOOL_RESULT_CHARS,
  type RunnerAttachmentUploadResponse,
  type RunnerEvent,
  type RunnerMemoryWriteResponse,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import type { TurnEventCollector } from "./turn-events";
import { log } from "./log";

/**
 * In-flight `memory.write` relays allowed per sandbox. A relay is
 * fire-and-forget (like `tool.call`) and holds a validated frame — up to
 * ~150KB of content — plus an awaited control-plane fetch until it settles.
 * A compromised supervisor emitting frames at line rate over the local
 * docker network would otherwise accumulate unbounded concurrent relays and
 * OOM the runner, taking every co-hosted tenant's sandbox with it. The
 * legitimate harvester sends serially (one file, awaited), so it never
 * exceeds 1 in flight; this ceiling only bites a flood, answering the excess
 * with a retryable refusal the harvester's paced re-attempt absorbs.
 */
export const MAX_INFLIGHT_MEMORY_WRITES_PER_SANDBOX = 8;

/**
 * Concurrent outbound file uploads (send_file) per sandbox, AFTER reassembly
 * — each holds up to 25 MB awaiting the api. The supervisor's tool sends
 * files one at a time (the model calls send_file serially), so 2 is the
 * ceiling for a legitimate agent and only a flood trips it; the excess gets a
 * retryable refusal the tool surfaces to the model. Reassembly itself is
 * bounded separately: ONE in-progress chunk run per sandbox (below).
 */
export const MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX = 2;

/**
 * A chunk run with no new part for this long is dropped: a supervisor that
 * died mid-file must not pin 25 MB of partial buffer forever. Well above the
 * inter-frame gap of a healthy stream (parts are sent back to back).
 */
export const FILE_UPLOAD_STALE_MS = 60_000;

/**
 * The ONE place a supervisor message becomes a control-plane event.
 *
 * An exhaustive switch on purpose: nothing downstream references the message
 * union, so this is the only compiler-enforced point where a new kind cannot
 * be added and silently dropped. Extracted from the composition root so the
 * mapping — including the paths that only occur when a sandbox is failing —
 * can be tested without a docker daemon.
 */

export interface SupervisorMessageHandlerDeps {
  /** Queue an event for the control plane (ordered, bounded — see index.ts). */
  report: (event: RunnerEvent) => void;
  collector: Pick<TurnEventCollector, "add" | "flush">;
  /**
   * Relay a platform-tool call to the control plane and return its answer
   * (step 7). Awaited on its OWN path, never through `report` — the report
   * chain is ordered-but-lossy by design (drops under backpressure, swallows
   * failed posts), which is fine for advisory events and fatal for an RPC:
   * a dropped event costs a reconnect, a dropped reply hangs a tool call
   * into its timeout.
   */
  toolCall: (
    sandboxId: string,
    call: Extract<SupervisorMessage, { kind: "tool.call" }>,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /**
   * Relay a harvested memory-file write (the write-back half of the
   * projection). The toolCall contract exactly: awaited on its OWN path
   * (an RPC on the lossy report chain hangs the harvester into its
   * timeout), throws on transport failure, and the handler answers the
   * sandbox in BOTH outcomes.
   */
  memoryWrite: (
    sandboxId: string,
    write: Extract<SupervisorMessage, { kind: "memory.write" }>,
  ) => Promise<RunnerMemoryWriteResponse>;
  /**
   * Relay a fully reassembled outbound file (send_file) to the control
   * plane. The memoryWrite contract exactly: awaited on its OWN path, throws
   * on transport failure, and the handler answers the sandbox in BOTH
   * outcomes with exactly one `file.result`.
   */
  uploadAttachment: (
    sandboxId: string,
    file: OutboundFile,
  ) => Promise<RunnerAttachmentUploadResponse>;
  /** Send a work item back down the sandbox's channel (the tool.result). */
  sendToSandbox: (sandboxId: string, item: WorkItem) => boolean;
  /** Test seam for the stale-run sweep clock. */
  now?: () => number;
  /**
   * The container this runner spawned for a sandbox (step 10). Stamped onto
   * process.state events so the control plane can tell a live process from a
   * stale row off a dead container — the THIRD authenticated fact, from the
   * runner's own map, never the supervisor's payload. Undefined means we have
   * no record of this sandbox's container, so the fact cannot be stamped.
   */
  containerRefOf: (sandboxId: string) => string | undefined;
}

/** A reassembled, checksum-verified outbound file, ready for the api. */
export interface OutboundFile {
  uploadId: string;
  conversationId: string;
  turnId: string;
  name: string;
  mimeType: string;
  sha256: string;
  caption?: string;
  bytes: Buffer;
}

type FilePart = Extract<SupervisorMessage, { kind: "file.part" }>;

/** The one in-progress chunk run a sandbox may have (the inbound assembler's
 * law, reversed): a different uploadId or an out-of-order part resets it
 * fail-closed and the abandoned run is answered with a refusal. */
interface FileRun {
  uploadId: string;
  nextPart: number;
  of: number;
  sizeBytes: number;
  chunks: Buffer[];
  total: number;
  lastPartAt: number;
}

/** Bound the serialized result at the SENDER (the wire law): an oversized
 * frame would be dropped whole by the supervisor's validator, turning a big
 * answer into a silent timeout. */
const boundedResult = (
  result: unknown,
): { result?: unknown; error?: string } => {
  const serialized = JSON.stringify(result ?? null);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return { result };
  return {
    error: `The tool result was too large to deliver (${serialized.length} chars).`,
  };
};

export const createSupervisorMessageHandler = ({
  report,
  collector,
  toolCall,
  memoryWrite,
  uploadAttachment,
  sendToSandbox,
  containerRefOf,
  now = () => Date.now(),
}: SupervisorMessageHandlerDeps) => {
  const relayToolCall = async (
    sandboxId: string,
    message: Extract<SupervisorMessage, { kind: "tool.call" }>,
  ): Promise<void> => {
    let outcome: { ok: boolean; result?: unknown; error?: string };
    try {
      outcome = await toolCall(sandboxId, message);
    } catch (error) {
      // Never silence: the supervisor's correlator would otherwise wait out
      // its full timeout for an answer that already died here.
      outcome = {
        ok: false,
        error: `The platform could not be reached: ${String(error).slice(0, 200)}`,
      };
    }
    const bounded = outcome.ok ? boundedResult(outcome.result) : {};
    const failedBounding = outcome.ok && bounded.error !== undefined;
    const delivered = sendToSandbox(sandboxId, {
      kind: "tool.result",
      callId: message.callId,
      ok: outcome.ok && !failedBounding,
      ...(outcome.ok && !failedBounding ? { result: bounded.result } : {}),
      ...(failedBounding ? { error: bounded.error } : {}),
      ...(!outcome.ok
        ? {
            error: (outcome.error ?? "Tool call failed").slice(
              0,
              MAX_TOOL_ERROR_CHARS,
            ),
          }
        : {}),
    });
    if (!delivered) {
      log("warn", "tool result had no channel to return on", {
        sandboxId,
        callId: message.callId,
      });
    }
  };

  // Per-sandbox in-flight relay count — the flood ceiling above.
  const inflightMemoryWrites = new Map<string, number>();

  const relayMemoryWrite = async (
    sandboxId: string,
    message: Extract<SupervisorMessage, { kind: "memory.write" }>,
  ): Promise<void> => {
    const inflight = inflightMemoryWrites.get(sandboxId) ?? 0;
    if (inflight >= MAX_INFLIGHT_MEMORY_WRITES_PER_SANDBOX) {
      // Answer immediately (never silence) with a retryable refusal — the
      // frame is dropped without a control-plane round-trip, so a flood
      // cannot accumulate retained bodies or amplify into the api.
      sendToSandbox(sandboxId, {
        kind: "memory.write.result",
        writeId: message.writeId,
        ok: false,
        retryable: true,
        error: "Too many memory writes in flight — retry shortly.",
      });
      return;
    }
    inflightMemoryWrites.set(sandboxId, inflight + 1);
    let outcome: RunnerMemoryWriteResponse;
    try {
      outcome = await memoryWrite(sandboxId, message);
    } catch (error) {
      // Never silence — the harvester would wait out its full timeout for
      // an answer that already died here. Transport-class failures are
      // retryable (the paced re-attempt is the recovery); the control
      // plane's own refusals arrive as a parsed `ok:false`, not here.
      outcome = {
        ok: false,
        retryable: true,
        error: `The platform could not be reached: ${String(error).slice(0, 200)}`,
      };
    } finally {
      const remaining = (inflightMemoryWrites.get(sandboxId) ?? 1) - 1;
      if (remaining <= 0) inflightMemoryWrites.delete(sandboxId);
      else inflightMemoryWrites.set(sandboxId, remaining);
    }
    const delivered = sendToSandbox(sandboxId, {
      kind: "memory.write.result",
      writeId: message.writeId,
      ok: outcome.ok,
      ...(outcome.created !== undefined && { created: outcome.created }),
      ...(outcome.revisionSeq !== undefined && {
        revisionSeq: outcome.revisionSeq,
      }),
      ...(outcome.noop !== undefined && { noop: outcome.noop }),
      ...(outcome.retryable !== undefined && { retryable: outcome.retryable }),
      ...(outcome.error !== undefined && {
        error: outcome.error.slice(0, MAX_TOOL_ERROR_CHARS),
      }),
    });
    if (!delivered) {
      log("warn", "memory write result had no channel to return on", {
        sandboxId,
        writeId: message.writeId,
      });
    }
  };

  // ── send_file: reassemble chunk runs, relay whole files ─────────────────

  const fileRuns = new Map<string, FileRun>();
  const inflightUploads = new Map<string, number>();

  const fileResult = (
    sandboxId: string,
    uploadId: string,
    outcome: RunnerAttachmentUploadResponse,
  ): void => {
    const delivered = sendToSandbox(sandboxId, {
      kind: "file.result",
      uploadId,
      ok: outcome.ok,
      ...(outcome.attachmentId !== undefined && {
        attachmentId: outcome.attachmentId,
      }),
      ...(outcome.retryable !== undefined && { retryable: outcome.retryable }),
      ...(outcome.error !== undefined && {
        error: outcome.error.slice(0, MAX_TOOL_ERROR_CHARS),
      }),
    });
    if (!delivered) {
      log("warn", "file result had no channel to return on", {
        sandboxId,
        uploadId,
      });
    }
  };

  const relayFile = async (
    sandboxId: string,
    file: OutboundFile,
  ): Promise<void> => {
    const inflight = inflightUploads.get(sandboxId) ?? 0;
    if (inflight >= MAX_INFLIGHT_FILE_UPLOADS_PER_SANDBOX) {
      // Refused BEFORE the control-plane round-trip: a flood cannot amplify
      // into the api or retain more buffers than the ceiling allows.
      fileResult(sandboxId, file.uploadId, {
        ok: false,
        retryable: true,
        error: "Too many files in flight — retry shortly.",
      });
      return;
    }
    inflightUploads.set(sandboxId, inflight + 1);
    let outcome: RunnerAttachmentUploadResponse;
    try {
      outcome = await uploadAttachment(sandboxId, file);
    } catch (error) {
      // The operator's line carries the cause (undici wraps the socket error
      // as `fetch failed`); the model's line stays short and honest.
      log("warn", "attachment upload failed", {
        sandboxId,
        uploadId: file.uploadId,
        sizeBytes: file.bytes.byteLength,
        error: String(error).slice(0, 200),
        cause:
          error instanceof Error && error.cause !== undefined
            ? String(error.cause).slice(0, 200)
            : undefined,
      });
      outcome = {
        ok: false,
        retryable: true,
        error: `The platform could not be reached: ${String(error).slice(0, 200)}`,
      };
    } finally {
      const remaining = (inflightUploads.get(sandboxId) ?? 1) - 1;
      if (remaining <= 0) inflightUploads.delete(sandboxId);
      else inflightUploads.set(sandboxId, remaining);
    }
    fileResult(sandboxId, file.uploadId, outcome);
  };

  /** Drop the sandbox's in-progress run, answering it so the supervisor's
   * correlator never has to time out. */
  const abandonRun = (sandboxId: string, why: string): void => {
    const run = fileRuns.get(sandboxId);
    if (!run) return;
    fileRuns.delete(sandboxId);
    fileResult(sandboxId, run.uploadId, { ok: false, error: why });
  };

  const applyFilePart = (sandboxId: string, part: FilePart): void => {
    // Stale sweep, lazily on the next frame from ANY sandbox: a run whose
    // supervisor died mid-file must not pin its buffer forever.
    const clock = now();
    for (const [other, run] of fileRuns) {
      if (clock - run.lastPartAt > FILE_UPLOAD_STALE_MS) {
        abandonRun(other, "The upload stalled and was dropped; send it again.");
      }
    }

    if (part.part === 1) {
      // A new run. If one was in progress it is abandoned fail-closed (the
      // inbound law): the supervisor never interleaves, so this only
      // happens after a supervisor-side failure or a redelivery.
      if (fileRuns.has(sandboxId)) {
        abandonRun(
          sandboxId,
          "A new upload started before this one finished; send it again.",
        );
      }
      // The declared size must fit the belt BEFORE a byte is buffered.
      if (part.sizeBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
        fileResult(sandboxId, part.uploadId, {
          ok: false,
          error: `Files are capped at ${Math.floor(MAX_OUTBOUND_ATTACHMENT_BYTES / (1024 * 1024))}MB.`,
        });
        return;
      }
      fileRuns.set(sandboxId, {
        uploadId: part.uploadId,
        nextPart: 1,
        of: part.of,
        sizeBytes: part.sizeBytes,
        chunks: [],
        total: 0,
        lastPartAt: clock,
      });
    }

    const run = fileRuns.get(sandboxId);
    if (
      !run ||
      run.uploadId !== part.uploadId ||
      run.nextPart !== part.part ||
      run.of !== part.of
    ) {
      // Discontinuity: reset fail-closed and answer whichever run this part
      // belongs to, so nothing waits out a timeout.
      const current = run?.uploadId;
      abandonRun(sandboxId, "The upload arrived out of order; send it again.");
      if (current !== part.uploadId) {
        fileResult(sandboxId, part.uploadId, {
          ok: false,
          error: "The upload arrived out of order; send it again.",
        });
      }
      return;
    }

    const chunk = Buffer.from(part.dataBase64, "base64");
    run.total += chunk.byteLength;
    if (run.total > run.sizeBytes) {
      // More bytes than declared: the sender lied or the stream is corrupt.
      abandonRun(sandboxId, "The upload exceeded its declared size.");
      return;
    }
    run.chunks.push(chunk);
    run.nextPart += 1;
    run.lastPartAt = clock;

    if (part.part < part.of) return;

    // Final part: the run is complete. Verify before relaying.
    fileRuns.delete(sandboxId);
    const bytes = Buffer.concat(run.chunks);
    if (bytes.byteLength !== part.sizeBytes) {
      fileResult(sandboxId, part.uploadId, {
        ok: false,
        error: "The upload was shorter than its declared size.",
      });
      return;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== part.sha256) {
      fileResult(sandboxId, part.uploadId, {
        ok: false,
        error: "The file's bytes did not match its checksum; send it again.",
      });
      return;
    }
    void relayFile(sandboxId, {
      uploadId: part.uploadId,
      conversationId: part.conversationId,
      turnId: part.turnId,
      name: part.name,
      mimeType: part.mimeType,
      sha256: part.sha256,
      ...(part.caption !== undefined && { caption: part.caption }),
      bytes,
    });
  };

  return (sandboxId: string, message: SupervisorMessage): void => {
    switch (message.kind) {
      case "file.part":
        // Reassembly is synchronous and bounded (one run per sandbox, size
        // declared up front); only the relay of a COMPLETE file is
        // fire-and-track, and it answers in BOTH outcomes.
        applyFilePart(sandboxId, message);
        break;
      case "tool.call":
        // Fire-and-track: the handler must return immediately (it runs on
        // the ws message path), and relayToolCall answers the sandbox in
        // BOTH outcomes, so nothing is ever silently dropped here.
        void relayToolCall(sandboxId, message);
        break;
      case "memory.write":
        // Fire-and-track, the tool-call shape exactly.
        void relayMemoryWrite(sandboxId, message);
        break;
      case "ready":
        report({ kind: "supervisor.ready", sandboxId });
        break;
      case "home.synced":
        // The sync ack (step 9) rides the ordered report chain. `sandboxId`
        // is the AUTHENTICATED channel's, never the payload's; a drop under
        // backpressure costs one paced re-push, nothing else — the control
        // plane's applied/desired pair re-derives the need.
        report({
          kind: "home.synced",
          sandboxId,
          generation: message.generation,
        });
        break;
      case "process.state": {
        // Background-process state (step 10) on the ordered report chain.
        // Stamp the container from the runner's OWN map — never the payload;
        // if we have no record of this sandbox's container we DROP the frame
        // rather than ship an unstamped fact (the control plane could not
        // tell a live process from a stale one without it). A dropped frame
        // costs one paced re-send (~30s), the reliability design's whole
        // point.
        const containerRef = containerRefOf(sandboxId);
        if (!containerRef) {
          log("warn", "process state with no known container; dropping", {
            sandboxId,
          });
          break;
        }
        report({
          kind: "process.state",
          sandboxId,
          containerRef,
          process: message.process,
        });
        break;
      }
      case "event":
        // `sandboxId` is the AUTHENTICATED channel's, not the message's —
        // the conversation and turn ids are supervisor-chosen, and a
        // supervisor may only ever speak for its own sandbox.
        collector.add(
          sandboxId,
          message.conversationId,
          message.turnId,
          message.event,
        );
        break;
      case "progress":
        // The liveness heartbeat rides `report()` as its own single-event
        // post, never the collector: heartbeats must not delay transcript
        // batches, and a control plane that predates the kind rejects one
        // heartbeat's POST instead of poisoning a shared batch. As with
        // `event`, `sandboxId` is the authenticated channel's.
        report({
          kind: "turn.progress",
          sandboxId,
          conversationId: message.conversationId,
          turnId: message.turnId,
        });
        break;
      case "turn.result":
        // Anything still buffered belongs before the terminal report.
        collector.flush(message.turnId);
        report({
          kind: "turn.finished",
          sandboxId,
          conversationId: message.conversationId,
          turnId: message.turnId,
          // Forwarded, not re-derived: only the supervisor knows whether
          // the turn ended or was cancelled.
          status: message.status,
          // Truncated at THIS sender: the supervisor wire leaves `error`
          // unbounded, but `turn.finished` caps it at 2000 — an oversized
          // string would fail the whole event batch's parse and lose the
          // terminal report it carries.
          ...(message.error && { error: message.error.slice(0, 2000) }),
          // The failure class rides beside the raw error, verbatim — the
          // control plane's allowlist owns its meaning.
          ...(message.errorCode && {
            errorCode: message.errorCode.slice(0, 64),
          }),
          ...(message.usage && { usage: message.usage }),
          ...(message.sessionRef && { sessionRef: message.sessionRef }),
          // Steer outcomes ride the terminal report so the settle and the
          // close arrive (or are lost) together.
          ...(message.followUps && { followUps: message.followUps }),
        });
        break;
      case "unhealthy":
        // A sandbox that says it can no longer serve turns IS stopped, as far
        // as the control plane is concerned — the supervisor ends its process
        // right after saying so, which stops the container.
        //
        // `stopped` rather than `failed`, deliberately: it is the same report
        // `deliverTurn` makes for an unreachable sandbox, so it rejoins the
        // ordinary wake path with no retry backoff, and it fails the turns
        // whose harness session just went away.
        log("warn", "sandbox reported itself unhealthy", {
          sandboxId,
          reason: message.reason,
        });
        report({
          kind: "sandbox.status",
          sandboxId,
          status: "stopped",
          error: message.reason,
        });
        break;
      default: {
        const unreachable: never = message;
        throw new Error(
          `unhandled supervisor message: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  };
};
