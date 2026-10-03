import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SupervisorMessage } from "@onecli/agent-protocol";
import {
  startPlatformTools,
  type PlatformTools,
  type PlatformToolDefinition,
} from "./platform-tools";

/**
 * The tool channel's supervisor half, driven over a REAL Unix socket — the
 * exact transport the bridge uses. The correlator's contract is the part
 * worth pinning hard: every bridge request gets an answer (resolve, timeout,
 * or teardown), because an unanswered request holds an MCP call open until
 * the vendor's own timeout, which reads as a hang.
 */

const TOOLS: PlatformToolDefinition[] = [
  {
    name: "schedule_task",
    description: "d",
    inputSchema: { type: "object" },
  },
];

/** A tool that appears only once a peer exists — the conditional shape a
 * deploy or a mid-run presence change adds to the surface. */
const MESSAGE_AGENT: PlatformToolDefinition = {
  name: "message_agent",
  description: "d",
  inputSchema: { type: "object" },
};

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const testSocketPath = () =>
  join(
    tmpdir(),
    `pt-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
  );

interface Rig {
  tools: PlatformTools;
  sent: SupervisorMessage[];
  socketPath: string;
  request: (
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

const rig = async (options?: {
  timeoutMs?: number;
  activeTurn?: () => { conversationId: string; turnId: string } | null;
  /** A live tool set — the supervisor's production shape since the
   * capability set can change under a running container. */
  tools?: () => PlatformToolDefinition[];
}): Promise<Rig> => {
  const sent: SupervisorMessage[] = [];
  const socketPath = testSocketPath();
  const tools = await startPlatformTools({
    socketPath,
    tools: options?.tools ?? TOOLS,
    send: (message) => sent.push(message),
    activeTurn: options?.activeTurn ?? (() => null),
    ...(options?.timeoutMs && { timeoutMs: options.timeoutMs }),
  });
  cleanup.push(() => tools.close());

  const socket: Socket = await new Promise((resolve, reject) => {
    const connection = createConnection(socketPath, () => resolve(connection));
    connection.once("error", reject);
  });
  socket.setEncoding("utf8");
  cleanup.push(() => void socket.destroy());

  const waiters = new Map<
    string,
    (response: Record<string, unknown>) => void
  >();
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.get(String(message.id));
      if (waiter) {
        waiters.delete(String(message.id));
        waiter(message);
      }
    }
  });

  let seq = 0;
  const request = (payload: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = `req-${seq++}`;
      waiters.set(id, resolve);
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    });

  return { tools, sent, socketPath, request };
};

describe("platform tools", () => {
  it("drops a connection streaming a newline-less frame — memory cannot grow unbounded", async () => {
    // The agent shares the container and can dial the socket directly.
    // MUTATION-PROOF: remove the buffer bound and the socket stays open.
    const { socketPath } = await rig();
    const flooder: Socket = await new Promise((resolve, reject) => {
      const c = createConnection(socketPath, () => resolve(c));
      c.once("error", reject);
    });
    cleanup.push(() => void flooder.destroy());

    const closed = new Promise<boolean>((resolve) => {
      flooder.on("close", () => resolve(true));
      flooder.on("error", () => resolve(true));
    });
    // A megabyte-plus with no newline: legal frames never approach this.
    flooder.write("x".repeat(1_100_000));
    expect(await closed).toBe(true);
  });

  it("advertises the capability tool definitions to the bridge", async () => {
    const { request } = await rig();
    const answer = await request({ op: "tools" });
    expect(answer.ok).toBe(true);
    expect(answer.tools).toEqual(TOOLS);
  });

  it("relays a call as a correlated tool.call and returns the tool.result", async () => {
    const { tools, sent, request } = await rig({
      activeTurn: () => ({ conversationId: "c-1", turnId: "t-1" }),
    });

    const pendingAnswer = request({
      op: "call",
      tool: "schedule_task",
      args: { name: "x" },
    });

    // The call is on the wire with the calling-turn context attached.
    await expect.poll(() => sent.length).toBe(1);
    const call = sent[0] as Extract<SupervisorMessage, { kind: "tool.call" }>;
    expect(call.kind).toBe("tool.call");
    expect(call.tool).toBe("schedule_task");
    expect(call.conversationId).toBe("c-1");
    expect(call.turnId).toBe("t-1");

    tools.handleToolResult({
      kind: "tool.result",
      callId: call.callId,
      ok: true,
      result: { cronId: "cr-1" },
    });

    const answer = await pendingAnswer;
    expect(answer.ok).toBe(true);
    expect(answer.result).toEqual({ cronId: "cr-1" });
  });

  it("times out into a tool error the model can read — the channel cannot retry", async () => {
    const { request } = await rig({ timeoutMs: 50 });
    const answer = await request({
      op: "call",
      tool: "schedule_task",
      args: {},
    });
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain("did not answer");
  });

  it("rejects everything pending on close — never leaves a bridge request hanging", async () => {
    const { tools, sent, request } = await rig();
    const pendingAnswer = request({
      op: "call",
      tool: "schedule_task",
      args: {},
    });
    await expect.poll(() => sent.length).toBe(1);

    await tools.close();

    const answer = await pendingAnswer;
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain("shutting down");
  });

  it("a LIVE tool set is read on every bridge startup — a capability attached mid-life is advertised to the next session", async () => {
    // jcode spawns a bridge per harness session and the bridge asks once at
    // its start, so the answer must reflect the container's CURRENT
    // capabilities, not the boot-time set: a Slack presence attached while
    // the container ran must reach the session started after it.
    // MUTATION-PROOF: resolve `options.tools` once at startPlatformTools
    // and the second answer still lacks send_message.
    let current: PlatformToolDefinition[] = [TOOLS[0]!];
    const { request } = await rig({ tools: () => current });
    const before = await request({ op: "tools" });
    expect((before.tools as { name: string }[]).map((t) => t.name)).toEqual([
      TOOLS[0]!.name,
    ]);
    current = [...TOOLS, { ...TOOLS[0]!, name: "send_message" }];
    const after = await request({ op: "tools" });
    expect((after.tools as { name: string }[]).map((t) => t.name)).toContain(
      "send_message",
    );
  });

  it("a call to a tool this container ONCE offered but withdrew is refused with an explanation, not 'unknown tool'", async () => {
    // Observed live (2026-09-15): a jcode session resumed after a capability
    // was withdrawn keeps the tool in its own registry — discovered tools
    // are unioned across attaches and never dropped — so the model can
    // still call send_message after its Slack app was removed. The socket
    // is the last honest voice: say what happened and what to do.
    // MUTATION-PROOF: drop the `everOffered` branch and the answer reverts
    // to `Unknown tool`.
    let current: PlatformToolDefinition[] = [
      ...TOOLS,
      { ...TOOLS[0]!, name: "send_message" },
    ];
    const { sent, request } = await rig({ tools: () => current });
    await request({ op: "tools" }); // the bridge saw send_message once
    current = TOOLS; // ...then the presence was removed
    const answer = await request({
      op: "call",
      tool: "send_message",
      args: {},
    });
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain("no longer available");
    expect(String(answer.error)).toContain("re-attached");
    expect(String(answer.error)).not.toContain("Unknown tool");
    expect(sent).toHaveLength(0);
    // A name that was NEVER offered keeps the plain refusal.
    const never = await request({ op: "call", tool: "made_up", args: {} });
    expect(String(never.error)).toContain("Unknown tool");
  });

  it("refuses a tool it does not serve without touching the wire", async () => {
    const { sent, request } = await rig();
    const answer = await request({ op: "call", tool: "made_up", args: {} });
    expect(answer.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("bounds oversized arguments at the sender instead of shipping a droppable frame", async () => {
    const { sent, request } = await rig();
    const answer = await request({
      op: "call",
      tool: "schedule_task",
      args: { blob: "x".repeat(40_000) },
    });
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain("too large");
    expect(sent).toHaveLength(0);
  });

  it("omits the calling-turn context when attribution is ambiguous", async () => {
    const { tools, sent, request } = await rig({ activeTurn: () => null });
    const pendingAnswer = request({
      op: "call",
      tool: "schedule_task",
      args: {},
    });
    await expect.poll(() => sent.length).toBe(1);
    const call = sent[0] as Extract<SupervisorMessage, { kind: "tool.call" }>;
    expect(call.conversationId).toBeUndefined();
    expect(call.turnId).toBeUndefined();
    tools.handleToolResult({
      kind: "tool.result",
      callId: call.callId,
      ok: true,
    });
    await pendingAnswer;
  });
});

describe("the local-executor seam (step 10)", () => {
  const localTool = (
    execute: PlatformToolDefinition["execute"],
  ): PlatformToolDefinition[] => [
    { name: "process_start", description: "d", inputSchema: {}, execute },
  ];

  const localRig = async (tools: PlatformToolDefinition[]) => {
    const sent: SupervisorMessage[] = [];
    const socketPath = testSocketPath();
    const pt = await startPlatformTools({
      socketPath,
      tools,
      send: (m) => sent.push(m),
      activeTurn: () => ({ conversationId: "cv", turnId: "t" }),
    });
    cleanup.push(() => pt.close());
    const socket: Socket = await new Promise((resolve, reject) => {
      const c = createConnection(socketPath, () => resolve(c));
      c.once("error", reject);
    });
    socket.setEncoding("utf8");
    cleanup.push(() => void socket.destroy());
    let buffer = "";
    const waiters = new Map<string, (r: Record<string, unknown>) => void>();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const m = JSON.parse(line) as Record<string, unknown>;
        waiters.get(String(m.id))?.(m);
      }
    });
    const request = (payload: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = "r1";
        waiters.set(id, resolve);
        socket.write(`${JSON.stringify({ id, ...payload })}\n`);
      });
    return { sent, request };
  };

  it("answers in-process and sends NOTHING on the transport", async () => {
    const { sent, request } = await localRig(
      localTool(async (_args, ctx) => ({ ok: true, result: { got: ctx } })),
    );
    const response = await request({
      op: "call",
      tool: "process_start",
      args: { command: "x" },
    });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      got: { conversationId: "cv", turnId: "t" },
    });
    // The whole point of the local seam: no tool.call ever crossed the wire.
    expect(sent).toEqual([]);
  });

  it("turns a throwing executor into a readable error", async () => {
    const { request } = await localRig(
      localTool(async () => {
        throw new Error("boom");
      }),
    );
    const response = await request({
      op: "call",
      tool: "process_start",
      args: {},
    });
    expect(response.ok).toBe(false);
    expect(String(response.error)).toContain("boom");
  });

  it("refuses an oversized local result (the 64k law applies here too)", async () => {
    const { request } = await localRig(
      localTool(async () => ({ ok: true, result: "z".repeat(65_000) })),
    );
    const response = await request({
      op: "call",
      tool: "process_start",
      args: {},
    });
    expect(response.ok).toBe(false);
    expect(String(response.error)).toContain("too large");
  });
});

/**
 * The tool-listing signal: how a starting session tells the supervisor it
 * has taken the CURRENT tool list rather than jcode's on-disk cache
 * (`.jcode-home/mcp-schema-cache.json`, served while MCP discovery is still
 * in flight). Without it, the first turn after a deploy that changed the
 * tool set advertises the previous boot's tools — observed live as
 * `complete_task` reading "unknown tool" in a resumed conversation.
 */
describe("platform tools: the tool-listing signal", () => {
  it("resolves the wait when a session lists tools AFTER the marker", async () => {
    const { tools, request } = await rig();
    // The supervisor's order: marker first, THEN start the session, so a
    // listing that races the start still counts.
    const marker = tools.listingMarker();
    const waited = tools.toolsListedSince(marker, 5_000);
    await request({ op: "tools" });
    await expect(waited).resolves.toBe(true);
  });

  it("does NOT count a listing that happened BEFORE the marker", async () => {
    // MUTATION-PROOF: make `toolsListedSince` ignore the marker (e.g.
    // `toolsListings > 0`) and this passes true immediately — which in
    // production means a new session proceeding on the PREVIOUS session's
    // listing, the exact stale-surface bug.
    const { tools, request } = await rig();
    await request({ op: "tools" }); // a previous session's listing
    const marker = tools.listingMarker();
    await expect(tools.toolsListedSince(marker, 150)).resolves.toBe(false);
  });

  it("times out to FALSE rather than stranding a turn with no MCP bridge", async () => {
    // A harness that never asks (no bridge) must still be able to answer:
    // a stale tool list is a far smaller harm than a turn that never runs.
    const { tools } = await rig();
    const started = Date.now();
    await expect(
      tools.toolsListedSince(tools.listingMarker(), 150),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("returns immediately when the listing already landed", async () => {
    const { tools, request } = await rig();
    const marker = tools.listingMarker();
    await request({ op: "tools" });
    // Already satisfied: a zero timeout must still resolve true, or a slow
    // path would be indistinguishable from a missing listing.
    await expect(tools.toolsListedSince(marker, 0)).resolves.toBe(true);
  });

  it("releases EVERY waiter on one listing (concurrent conversations)", async () => {
    // Two conversations can start sessions at once; one listing must not
    // leave the other hanging until its timeout.
    const { tools, request } = await rig();
    const marker = tools.listingMarker();
    const first = tools.toolsListedSince(marker, 5_000);
    const second = tools.toolsListedSince(marker, 5_000);
    await request({ op: "tools" });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("still advertises the CURRENT tool set when the listing arrives", async () => {
    // The signal is only useful if the list it accompanies is live: the
    // bridge must answer from the callback, not a boot-time snapshot.
    let peers = false;
    const { tools, request } = await rig({
      tools: () => (peers ? [...TOOLS, MESSAGE_AGENT] : TOOLS),
    });
    peers = true;
    const marker = tools.listingMarker();
    const response = await request({ op: "tools" });
    await expect(tools.toolsListedSince(marker, 5_000)).resolves.toBe(true);
    const names = (response.tools as { name: string }[] | undefined)?.map(
      (definition) => definition.name,
    );
    expect(names).toContain("message_agent");
  });

  it("releases a waiting first turn on shutdown instead of hanging", async () => {
    // MUTATION-PROOF: drop the waiter release from `close()` and this waits
    // the full timeout — in production, a container shutting down during a
    // session start would stall for TOOL_LISTING_WAIT_MS before exiting.
    const { tools } = await rig();
    // A long bound, so passing can only mean close() released the waiter.
    const waited = tools.toolsListedSince(tools.listingMarker(), 60_000);
    await tools.close();
    // False, not true: no listing ever happened, and saying otherwise would
    // claim the session holds a tool list it never took.
    await expect(waited).resolves.toBe(false);
  });
});
