import {
  MAX_TOOL_ERROR_CHARS,
  MAX_TOOL_RESULT_CHARS,
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
  /** Send a work item back down the sandbox's channel (the tool.result). */
  sendToSandbox: (sandboxId: string, item: WorkItem) => boolean;
  /**
   * The container this runner spawned for a sandbox (step 10). Stamped onto
   * process.state events so the control plane can tell a live process from a
   * stale row off a dead container — the THIRD authenticated fact, from the
   * runner's own map, never the supervisor's payload. Undefined means we have
   * no record of this sandbox's container, so the fact cannot be stamped.
   */
  containerRefOf: (sandboxId: string) => string | undefined;
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
  sendToSandbox,
  containerRefOf,
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

  return (sandboxId: string, message: SupervisorMessage): void => {
    switch (message.kind) {
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
