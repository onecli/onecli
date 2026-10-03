import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "./log";

/**
 * The platform-tool channel, supervisor side (step 7, §3.7 channel 2).
 *
 * The harness spawns our stdio MCP bridge; the bridge dials THIS module over
 * a local Unix socket; each tool invocation becomes a correlated `tool.call`
 * on the existing runner WebSocket, and the runner's `tool.result` resolves
 * it. The correlator lives HERE — above the transport — so the ws driver's
 * drop-and-continue laws stay intact and the stdio dev driver keeps working
 * unmodified.
 *
 * Three hard constraints shape it, all from the channel's own physics:
 * - The runner ws cannot reconnect (single-use token), so a call in flight
 *   when the socket dies has no retry path: the TIMEOUT is the recovery, and
 *   it must resolve into a tool error the model can read.
 * - jcode fails any MCP call at 30s. Our ceiling sits under it (25s) so the
 *   model always sees OUR error text, never the vendor's generic timeout.
 * - The reader loop must never block: `handleToolResult` only resolves a map
 *   entry, exactly as `turn.abort` is handled inline.
 *
 * The socket is NOT a trust boundary: the agent shares the container and the
 * uid, and could dial it directly — which grants nothing, because identity is
 * attached downstream from authenticated facts (the runner stamps the sandbox
 * from the channel; the api re-fences against the runner's token). The only
 * thing the socket path buys is that it lives OUTSIDE the home, so
 * boot-time state never mixes with agent-owned files.
 */

/**
 * Per-process, deliberately: one container runs one supervisor, but tests —
 * and any future co-located pair — must never race each other on a fixed
 * path. The jcode adapter reads the same function, so the mcp.json it writes
 * always names the socket THIS process is serving.
 */
export const platformToolsSocketPath = (): string =>
  join(tmpdir(), `onecli-platform-tools-${process.pid}.sock`);

/** Under jcode's own 30s MCP-call failure, so timeouts stay OUR words. */
const TOOL_CALL_TIMEOUT_MS = 25_000;

/** A tool the platform serves, in the shape MCP advertises: name, prose, and
 * a plain JSON Schema (the api's zod is the enforcement authority; this is
 * the model-facing contract). */
export interface PlatformToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * LOCAL execution (step 10): present = the supervisor itself answers and
   * the call never crosses the wire. Reserved for capabilities whose physics
   * live in this container — spawning processes — where a control-plane
   * round-trip could not act at all; everything else stays control-plane
   * executed (fencing, caps, audit). The local handler is the enforcement
   * authority for its own args (no control-plane zod ever sees them) and
   * must be non-blocking by construction; jcode's own 30s MCP cap is the
   * outer bound.
   */
  execute?: (
    args: unknown,
    context: { conversationId: string; turnId: string } | null,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

/** A capability contributes its instruction fragment through the renderer and
 * its tools through here — they arrive together and disappear together. */
export interface PlatformToolsOptions {
  socketPath?: string;
  /** Test seam only; production always uses TOOL_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * The tool set, or a function returning the CURRENT one. jcode spawns a
   * fresh bridge per session and the bridge asks once at startup, so a
   * function lets a session started after a mid-run capability change
   * (a Slack presence attached while the container was awake) advertise
   * the tools that change brought — the array form is a fixed set.
   */
  tools: PlatformToolDefinition[] | (() => PlatformToolDefinition[]);
  send: (message: SupervisorMessage) => void;
  /**
   * The calling turn, when it is unambiguous — the supervisor serializes
   * turns per conversation, but different conversations may overlap. Given
   * the tool's name, the supervisor can attribute a call to the ONE
   * conversation whose harness session currently has that tool open (the
   * `tool.started` frame precedes the MCP call); with no such unique
   * conversation the caller cannot be attributed and context is omitted
   * (the control plane then creates the schedule without an origin anchor,
   * which degrades delivery, never authorization).
   */
  activeTurn: (
    toolName?: string,
  ) => { conversationId: string; turnId: string } | null;
}

interface PendingCall {
  resolve: (item: Extract<WorkItem, { kind: "tool.result" }>) => void;
  timer: NodeJS.Timeout;
}

export interface PlatformTools {
  /** Resolve a correlated result — called INLINE from the reader loop. */
  handleToolResult(item: Extract<WorkItem, { kind: "tool.result" }>): void;
  /**
   * Resolves once jcode has ASKED this bridge for its tool list at least
   * once since `after` (a marker taken before the session was started).
   *
   * jcode discovers MCP tools ASYNCHRONOUSLY after a session starts, and
   * until that lands it serves the list cached on disk
   * (`.jcode-home/mcp-schema-cache.json`) — so a turn taken immediately
   * after a start can carry the PREVIOUS boot's tools. Waiting for the
   * bridge's own `tools` request is the exact, observable moment the new
   * list was taken: no sleep, no polling, no guessing.
   *
   * The count is PER BRIDGE, not per session: a connection does not say
   * which session it serves, so when two conversations start sessions at
   * once, either one's listing can release both waits. The loser then
   * proceeds exactly as it does today (possibly one stale turn) — never
   * worse, and it is bounded by its own next listing. Tightening this
   * would need a session identifier on the bridge handshake, which the
   * harness does not send.
   */
  toolsListedSince(after: number, timeoutMs: number): Promise<boolean>;
  /** A marker for `toolsListedSince`, taken BEFORE starting a session. */
  listingMarker(): number;
  close(): Promise<void>;
}

interface BridgeRequest {
  id?: unknown;
  op?: unknown;
  tool?: unknown;
  args?: unknown;
}

export const startPlatformTools = async (
  options: PlatformToolsOptions,
): Promise<PlatformTools> => {
  const currentTools = (): PlatformToolDefinition[] =>
    typeof options.tools === "function" ? options.tools() : options.tools;
  /** Every tool name this container has EVER advertised — the set a resumed
   * harness session may still believe in after a capability was withdrawn. */
  const everOffered = new Set<string>();
  /**
   * How many times a jcode session has asked this bridge for its tools.
   * Monotonic, so a first turn can tell "a listing happened AFTER my
   * session started" from "one happened earlier, for a previous session".
   */
  let toolsListings = 0;
  /** Resolvers for first turns waiting on a listing; the argument is the
   * answer they get (true = a listing landed, false = it never will). */
  const listingWaiters = new Set<(listed: boolean) => void>();
  const socketPath = options.socketPath ?? platformToolsSocketPath();
  const pending = new Map<string, PendingCall>();
  const connections = new Set<Socket>();
  let closed = false;

  const callTool = (
    tool: string,
    args: unknown,
  ): Promise<Extract<WorkItem, { kind: "tool.result" }>> =>
    new Promise((resolve) => {
      const callId = randomUUID();
      // Bounded at the SENDER (the wire law): an oversized frame is dropped
      // whole by the runner's validator, and the caller would wait out the
      // timeout for an answer that was never readable.
      const serialized = JSON.stringify(args ?? null);
      if (serialized.length > MAX_TOOL_ARGS_CHARS) {
        resolve({
          kind: "tool.result",
          callId,
          ok: false,
          error: `Tool arguments too large (${serialized.length} chars; limit ${MAX_TOOL_ARGS_CHARS}).`,
        });
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(callId);
        resolve({
          kind: "tool.result",
          callId,
          ok: false,
          error:
            "The platform did not answer this tool call in time. It may have been applied — check before retrying anything that creates or cancels.",
        });
      }, options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS);
      timer.unref();
      pending.set(callId, { resolve, timer });

      const context = options.activeTurn(tool);
      options.send({
        kind: "tool.call",
        callId,
        tool,
        args,
        ...(context ?? {}),
      });
    });

  const serveConnection = (socket: Socket): void => {
    let buffer = "";
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", (error) => {
      log("warn", "platform-tools socket error", { error: String(error) });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // A newline-less stream must not grow this process's heap forever —
      // the agent shares the container and can dial this socket directly.
      // Well above any legal frame (args cap at 32k), so only abuse trips it.
      if (buffer.length > 1_000_000) {
        log("warn", "platform-tools connection dropped: oversized frame");
        socket.destroy();
        return;
      }
      // JSONL framing; a malformed line answers an error rather than killing
      // the connection — the bridge correlates by id and moves on.
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void handleLine(line, socket);
      }
    });
  };

  const respond = (socket: Socket, payload: Record<string, unknown>): void => {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(payload)}\n`);
  };

  const handleLine = async (line: string, socket: Socket): Promise<void> => {
    let request: BridgeRequest;
    try {
      request = JSON.parse(line) as BridgeRequest;
    } catch {
      respond(socket, { ok: false, error: "malformed request" });
      return;
    }
    const id = typeof request.id === "string" ? request.id : null;
    if (!id) {
      respond(socket, { ok: false, error: "missing request id" });
      return;
    }

    if (request.op === "tools") {
      const tools = currentTools();
      for (const definition of tools) everOffered.add(definition.name);
      respond(socket, { id, ok: true, tools });
      // A session just took its tool list from US, not from the on-disk
      // cache: that is the moment a waiting first turn may proceed.
      toolsListings += 1;
      for (const waiter of listingWaiters) waiter(true);
      listingWaiters.clear();
      return;
    }

    if (request.op === "call") {
      const tool = typeof request.tool === "string" ? request.tool : "";
      const definition = currentTools().find((entry) => entry.name === tool);
      if (!definition) {
        // A harness session resumed after a capability was WITHDRAWN keeps
        // the tool in its own registry (jcode unions discovered tools on
        // attach and never drops one — observed live), so the model can
        // still call a tool this container no longer offers. Say why, in
        // words the model can act on, rather than "unknown tool".
        respond(socket, {
          id,
          ok: false,
          error: everOffered.has(tool)
            ? `"${tool}" is no longer available: the capability behind it was removed (for a messaging tool, the chat app was detached or uninstalled). Tell the person what you were asked to do cannot be done until it is re-attached from the dashboard; do not retry.`
            : `Unknown tool "${tool}"`,
        });
        return;
      }
      if (definition.execute) {
        // The local path (step 10): answered in-process, never on the wire.
        let outcome: { ok: boolean; result?: unknown; error?: string };
        try {
          outcome = await definition.execute(
            request.args,
            options.activeTurn(tool),
          );
        } catch (error) {
          outcome = {
            ok: false,
            error: `The tool failed: ${String(error).slice(0, 200)}`,
          };
        }
        // The 64k result law is enforced at the RUNNER for forwarded calls;
        // this path never crosses the runner, so the same law is applied
        // here — an unbounded local result must not reach the model either.
        if (
          outcome.ok &&
          JSON.stringify(outcome.result ?? null).length > MAX_TOOL_RESULT_CHARS
        ) {
          outcome = {
            ok: false,
            error: "The tool result was too large to deliver.",
          };
        }
        respond(socket, {
          id,
          ok: outcome.ok,
          ...(outcome.ok ? { result: outcome.result ?? null } : {}),
          ...(outcome.ok ? {} : { error: outcome.error ?? "Tool call failed" }),
        });
        return;
      }
      const result = await callTool(tool, request.args);
      respond(socket, {
        id,
        ok: result.ok,
        ...(result.ok ? { result: result.result ?? null } : {}),
        ...(result.ok ? {} : { error: result.error ?? "Tool call failed" }),
      });
      return;
    }

    respond(socket, { id, ok: false, error: "unknown op" });
  };

  // A stale socket file from a previous process in this container would make
  // listen() throw EADDRINUSE forever; the file is boot-owned state.
  rmSync(socketPath, { force: true });
  const server: Server = createServer(serveConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // The socket must never be what keeps a finished supervisor alive.
  server.unref();
  log("info", "platform tools listening", {
    socketPath,
    tools: currentTools().map((definition) => definition.name),
  });

  return {
    handleToolResult(item) {
      const entry = pending.get(item.callId);
      if (!entry) return; // late answer after timeout/teardown — nothing waits
      pending.delete(item.callId);
      clearTimeout(entry.timer);
      entry.resolve(item);
    },
    listingMarker() {
      return toolsListings;
    },
    async toolsListedSince(after, timeoutMs) {
      if (toolsListings > after) return true;
      // A closed bridge will never list again: answer now rather than make
      // a late caller sit out the whole bound.
      if (closed) return false;
      // The BOUND matters more than the wait: a harness that never asks
      // (no MCP, or a bridge that failed to connect) must not strand the
      // turn. Timing out returns false and the caller proceeds — a
      // possibly-stale tool list is a far smaller harm than a turn that
      // never runs.
      return await new Promise<boolean>((resolve) => {
        const waiter = (listed: boolean): void => {
          clearTimeout(timer);
          listingWaiters.delete(waiter);
          resolve(listed);
        };
        const timer = setTimeout(() => {
          listingWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs);
        // Never let this wait hold a finished supervisor alive.
        timer.unref?.();
        listingWaiters.add(waiter);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      // Release anything waiting on a tool listing that will now never
      // come: the same law as the pending calls below — nothing waits on a
      // closed bridge for its own timeout. They resolve FALSE (no listing
      // happened), which is the honest answer.
      for (const waiter of listingWaiters) waiter(false);
      listingWaiters.clear();
      // Reject everything in flight FIRST: a pending bridge request whose
      // promise never settles holds its MCP call until jcode's own timeout,
      // which reads as a hang, not a shutdown.
      for (const [callId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({
          kind: "tool.result",
          callId,
          ok: false,
          error: "The agent is shutting down; this tool call was abandoned.",
        });
      }
      pending.clear();
      // The awaiting handlers resume on the microtask queue and write their
      // responses; give them that turn BEFORE the connections are torn down,
      // or the rejection above never reaches the bridge.
      await new Promise((resolve) => setImmediate(resolve));
      for (const socket of connections) socket.destroy();
      connections.clear();
      // `server.close` only completes once every connection is gone — which
      // the destroy above guarantees; without it this would wait forever on
      // a bridge that has no reason to hang up.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
  };
};
