import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Harness,
  SupervisorMessage,
  SupervisorTransport,
  SupervisorWorkItem,
} from "@onecli/agent-protocol";
import { createFakeHarness } from "./harness/fake";
import { runSupervisor } from "./supervisor";

/**
 * SEND NOW through the supervisor: the person asked the run
 * to read a waiting follow-up now. The laws under test:
 *
 * - Delivered and waiting behind a running tool: the tool is moved, the
 *   answer `message.sent_now {moved: true, toolName}` goes out under the
 *   FOLLOW-UP's id, and the follow-up joins right after, long before the
 *   tool would have ended.
 * - A request in the same batch as the delivery waits for it (the inline
 *   steer drain), so it sees the delivery instead of racing it.
 * - Nothing running: `moved: false`, and nothing is cut short.
 * - Never delivered here (the harness refused the steer): `moved: false`.
 * - Already read, or not this run any more: silence.
 * - A harness without the capability is never asked: `moved: false`.
 */

const config = (homeDir: string) => ({
  homeDir,
  model: undefined,
  effort: undefined,
  instructions: "You are the test agent.",
  agentName: "Ada",
  channels: [],
  peers: [],
  connections: [],
  harness: "fake",
  runnerWsUrl: undefined,
  bootstrapToken: undefined,
  sandboxId: undefined,
  outboundAttachments: false,
});

const home = () => mkdtempSync(join(tmpdir(), "sup-send-now-"));

const createTestTransport = () => {
  const sent: SupervisorMessage[] = [];
  const queue: SupervisorWorkItem[] = [];
  let notify: (() => void) | undefined;

  const api = {
    push(...items: SupervisorWorkItem[]) {
      queue.push(...items);
      notify?.();
      notify = undefined;
    },
    events(turnId: string) {
      return sent.flatMap((m) =>
        m.kind === "event" && m.turnId === turnId ? [m.event] : [],
      );
    },
    results() {
      return sent.filter((m) => m.kind === "turn.result");
    },
    async until(predicate: () => boolean, label: string) {
      for (let i = 0; i < 1000; i += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    async finish(run: Promise<void>) {
      api.push({ kind: "shutdown" });
      await run;
    },
    transport: {
      async *incoming(): AsyncIterable<SupervisorWorkItem> {
        for (;;) {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) continue;
            yield item;
            if (item.kind === "shutdown") return;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
      send(message: SupervisorMessage) {
        sent.push(message);
      },
      close() {
        return Promise.resolve();
      },
    } satisfies SupervisorTransport,
  };
  return api;
};

/** A turn that sits inside a `bash` for `ms`, then says it is done. */
const deliverLongTool = (ms: number): SupervisorWorkItem => ({
  kind: "turn.deliver",
  turnId: "t1",
  conversationId: "cv",
  message: `@fake:v1 ${JSON.stringify({
    steps: [
      { op: "bash", ms },
      { op: "text", text: "build finished" },
    ],
  })}`,
});

const steer: SupervisorWorkItem = {
  kind: "turn.message",
  turnId: "f1",
  targetTurnId: "t1",
  conversationId: "cv",
  message: "stop and check prod",
};

const sendNow = (turnId = "f1", targetTurnId = "t1"): SupervisorWorkItem => ({
  kind: "turn.send_now",
  turnId,
  targetTurnId,
  conversationId: "cv",
});

/** Wrap the fake so a test can strip what a weaker harness lacks. */
const harnessWith = (
  tweak: (session: Awaited<ReturnType<Harness["startSession"]>>) => void,
  capabilities: Partial<Harness["capabilities"]> = {},
): Harness => {
  const base = createFakeHarness();
  return {
    ...base,
    capabilities: { ...base.capabilities, ...capabilities },
    startSession: async (options) => {
      const session = await base.startSession(options);
      tweak(session);
      return session;
    },
    onFailure: base.onFailure.bind(base),
    dispose: base.dispose.bind(base),
  };
};

const toolStarted = (t: ReturnType<typeof createTestTransport>) => () =>
  t.events("t1").some((e) => e.type === "tool.started");

describe("SEND NOW", () => {
  it("moves the running tool, answers under the follow-up, and the follow-up joins long before the tool would have ended", async () => {
    const t = createTestTransport();
    const run = runSupervisor(config(home()), createFakeHarness(), t.transport);
    const started = Date.now();

    t.push(deliverLongTool(20_000));
    await t.until(toolStarted(t), "the tool to start");
    t.push(steer, sendNow());
    await t.until(() => t.results().length === 1, "the turn to end");
    await t.finish(run);

    expect(Date.now() - started).toBeLessThan(10_000);
    // The answer, under the FOLLOW-UP's own id, never under the turn.
    expect(t.events("f1")).toContainEqual({
      type: "message.sent_now",
      moved: true,
      toolName: "bash",
    });
    expect(t.events("t1").some((e) => e.type === "message.sent_now")).toBe(
      false,
    );
    // The tool really was cut short, and the message then joined.
    expect(t.events("t1")).toContainEqual(
      expect.objectContaining({
        type: "tool.finished",
        output: "[bash moved to background]",
      }),
    );
    expect(t.results()[0]?.followUps).toEqual([
      { turnId: "f1", outcome: "joined" },
    ]);
  });

  it("answers moved: false when no tool is running, and cuts nothing short", async () => {
    const t = createTestTransport();
    const run = runSupervisor(config(home()), createFakeHarness(), t.transport);

    t.push({
      kind: "turn.deliver",
      turnId: "t1",
      conversationId: "cv",
      message: `@fake:v1 ${JSON.stringify({
        steps: [
          { op: "text", text: "thinking" },
          { op: "sleep", ms: 400 },
          { op: "text", text: "done" },
        ],
      })}`,
    });
    await t.until(
      () => t.events("t1").some((e) => e.type === "text.delta"),
      "the turn to start",
    );
    t.push(steer, sendNow());
    await t.until(() => t.results().length === 1, "the turn to end");
    await t.finish(run);

    expect(t.events("f1")).toContainEqual({
      type: "message.sent_now",
      moved: false,
    });
    expect(t.results()[0]?.followUps).toEqual([
      { turnId: "f1", outcome: "joined" },
    ]);
  });

  it("answers moved: false for a message never delivered here (the harness refused it)", async () => {
    const t = createTestTransport();
    let moves = 0;
    const harness = harnessWith((session) => {
      session.steer = () => Promise.reject(new Error("refused"));
      const move = session.backgroundRunningTool?.bind(session);
      session.backgroundRunningTool = () => {
        moves += 1;
        return move ? move() : Promise.resolve({ moved: false });
      };
    });
    const run = runSupervisor(config(home()), harness, t.transport);

    t.push(deliverLongTool(600));
    await t.until(toolStarted(t), "the tool to start");
    t.push(steer, sendNow());
    await t.until(() => t.results().length === 1, "the turn to end");
    await t.finish(run);

    expect(moves).toBe(0);
    expect(t.events("f1")).toContainEqual({
      type: "message.sent_now",
      moved: false,
    });
  });

  it("is silent for a message already read, and for a run that is not the active one", async () => {
    const t = createTestTransport();
    const run = runSupervisor(config(home()), createFakeHarness(), t.transport);

    t.push(deliverLongTool(20_000));
    await t.until(toolStarted(t), "the tool to start");
    t.push(steer, sendNow());
    await t.until(
      () => t.events("t1").some((e) => e.type === "message.joined"),
      "the follow-up to join",
    );
    // Already read: a second request (another tab) says nothing.
    t.push(sendNow(), sendNow("f9", "t-gone"));
    await t.until(() => t.results().length === 1, "the turn to end");
    await t.finish(run);

    expect(
      t.events("f1").filter((e) => e.type === "message.sent_now"),
    ).toHaveLength(1);
    expect(t.events("f9")).toEqual([]);
  });

  it("a harness without the capability is never asked, and answers moved: false", async () => {
    const t = createTestTransport();
    let moves = 0;
    const harness = harnessWith(
      (session) => {
        session.backgroundRunningTool = () => {
          moves += 1;
          return Promise.resolve({ moved: true, toolName: "bash" });
        };
      },
      { backgroundTool: false },
    );
    const run = runSupervisor(config(home()), harness, t.transport);

    t.push(deliverLongTool(600));
    await t.until(toolStarted(t), "the tool to start");
    t.push(steer, sendNow());
    await t.until(() => t.results().length === 1, "the turn to end");
    await t.finish(run);

    expect(moves).toBe(0);
    expect(t.events("f1")).toContainEqual({
      type: "message.sent_now",
      moved: false,
    });
  });

  it("a failing move is logged, never fatal, and never reported as a result it does not know", async () => {
    const t = createTestTransport();
    const harness = harnessWith((session) => {
      session.backgroundRunningTool = () =>
        Promise.reject(new Error("daemon went away"));
    });
    const run = runSupervisor(config(home()), harness, t.transport);

    t.push(deliverLongTool(600));
    await t.until(toolStarted(t), "the tool to start");
    t.push(steer, sendNow());
    await t.until(() => t.results().length === 1, "the turn to end");
    await t.finish(run);

    expect(t.results()[0]?.status).toBe("done");
    expect(t.events("f1").some((e) => e.type === "message.sent_now")).toBe(
      false,
    );
  });
});
