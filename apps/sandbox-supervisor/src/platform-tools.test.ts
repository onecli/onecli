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
}): Promise<Rig> => {
  const sent: SupervisorMessage[] = [];
  const socketPath = testSocketPath();
  const tools = await startPlatformTools({
    socketPath,
    tools: TOOLS,
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
