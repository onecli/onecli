import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AttachmentManifestEntry,
  Harness,
  HarnessEvent,
  SupervisorMessage,
  SupervisorTransport,
  SupervisorWorkItem,
} from "@onecli/agent-protocol";
import { ceilingWarningSteerId } from "@onecli/agent-protocol";
import { MAX_ANSWER_CHARS } from "./answer";
import { createFakeHarness } from "./harness/fake";
import { runSupervisor } from "./supervisor";

/**
 * Mid-run steering through the supervisor (the follow-up plane's sandbox
 * half). The laws under test:
 *
 * - A `turn.message` naming the ACTIVE turn is delivered into its live run
 *   and its confirmation comes back as `turn.result.followUps: joined`.
 * - One that arrives BEFORE its turn's deliver (a same-batch race) parks in
 *   the inbox and drains at the turn's first event — the message still
 *   joins.
 * - One whose target never runs here is pruned when another turn starts,
 *   with NO outcome — promotion (control-plane-side) owns it.
 * - A harness without the capability is never asked to steer — the
 *   queue-only degrade.
 * - Only ids this supervisor actually delivered are honored: an adapter
 *   cannot mint `joined` for messages it was never handed.
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

const home = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const createTestTransport = () => {
  const sent: SupervisorMessage[] = [];
  const queue: SupervisorWorkItem[] = [];
  let notify: (() => void) | undefined;

  const api = {
    sent,
    push(item: SupervisorWorkItem) {
      queue.push(item);
      notify?.();
      notify = undefined;
    },
    of<K extends SupervisorMessage["kind"]>(kind: K) {
      return sent.filter(
        (m): m is Extract<SupervisorMessage, { kind: K }> => m.kind === kind,
      );
    },
    async until(predicate: () => boolean, label: string) {
      for (let i = 0; i < 400; i += 1) {
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

const deliver = (
  turnId: string,
  conversationId: string,
  message = "long task",
): SupervisorWorkItem => ({
  kind: "turn.deliver",
  turnId,
  conversationId,
  message,
});

const steer = (
  turnId: string,
  targetTurnId: string,
  conversationId: string,
  message = "also do this",
  context?: string,
  attachments?: AttachmentManifestEntry[],
): SupervisorWorkItem => ({
  kind: "turn.message",
  turnId,
  targetTurnId,
  conversationId,
  message,
  ...(context && { context }),
  ...(attachments && { attachments }),
});

/** A long turn, so a steer sent mid-run has room to land inside it. */
const longScript = (): AgentEvent[] => [
  ...Array.from({ length: 60 }, (_, i) => ({
    type: "text.delta" as const,
    text: `chunk-${i}`,
  })),
  { type: "turn.done" as const },
];

type TestTransport = ReturnType<typeof createTestTransport>;

const followUpsOf = (t: TestTransport, turnId: string) =>
  t.of("turn.result").find((r) => r.turnId === turnId)?.followUps;

/**
 * Run one turn on the fake harness, but with a scripted stream that waits
 * for a steer to arrive before playing `afterSteer`: what the harness
 * reports back about the follow-up (`message.joined`, then
 * `message.replied` with its reply) is the test's to write. Returns every
 * `text` the supervisor sent, by turn.
 */
const runScriptedSteer = async (
  afterSteer: HarnessEvent[],
): Promise<{ turnId: string; event: AgentEvent }[]> => {
  const base = createFakeHarness();
  let steered: (() => void) | undefined;
  const steeredIn = new Promise<void>((resolve) => {
    steered = resolve;
  });
  const startSession: Harness["startSession"] = async (options) => {
    const session = await base.startSession(options);
    return {
      sessionRef: session.sessionRef,
      abort: session.abort.bind(session),
      steer: async () => steered?.(),
      async *runTurn(input) {
        void input;
        yield { type: "turn.started" };
        await steeredIn;
        yield* afterSteer;
      },
    };
  };
  const harness: Harness = {
    ...base,
    startSession,
    onFailure: base.onFailure.bind(base),
    dispose: base.dispose.bind(base),
  };
  const t = createTestTransport();
  const run = runSupervisor(config(home("sup-steer-")), harness, t.transport);

  t.push(deliver("t1", "cv-a"));
  await t.until(
    () => t.of("event").some((m) => m.event.type === "turn.started"),
    "the turn to start",
  );
  t.push(steer("f1", "t1", "cv-a", "and the other thing"));
  await t.until(() => t.of("turn.result").length === 1, "the turn to end");
  await t.finish(run);

  expect(followUpsOf(t, "t1")).toEqual([{ turnId: "f1", outcome: "joined" }]);
  return t
    .of("event")
    .filter((m) => m.event.type === "text")
    .map((m) => ({ turnId: m.turnId, event: m.event }));
};

describe("steering into the live turn", () => {
  it("a steer for the ACTIVE turn joins it and reports joined on turn.result", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-steer-")),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    // Wait until the turn is demonstrably mid-run, then steer.
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(steer("f1", "t1", "cv-a", "fold this in"));

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(followUpsOf(t, "t1")).toEqual([{ turnId: "f1", outcome: "joined" }]);
    // The fake injects the steered text into the same run, and its reply
    // streams under the FOLLOW-UP it answers: the delta carrying
    // the echo rides the follow-up's id, never the target's, so a reader
    // sees the reply being written under the message it answers.
    const echoed = (turnId: string) =>
      t
        .of("event")
        .some(
          (m) =>
            m.turnId === turnId &&
            m.event.type === "text.delta" &&
            m.event.text.includes("fold this in"),
        );
    expect(echoed("f1")).toBe(true);
    expect(echoed("t1")).toBe(false);
    // The confirmation event precedes the terminal (stream coherence).
    const kinds = t
      .of("event")
      .filter((m) => m.turnId === "t1")
      .map((m) => m.event.type);
    expect(kinds.indexOf("message.joined")).toBeGreaterThan(-1);
    expect(kinds.indexOf("message.joined")).toBeLessThan(
      kinds.lastIndexOf("turn.done"),
    );
  });

  it("a steer's frame is composed in front of the words at the harness boundary, and only when sent", async () => {
    // The control plane marks a PERSON's follow-up with a delivery-only
    // context ("a new message arrived while you were working"); the
    // supervisor hands the harness `context + words`, like a turn's memory
    // context, and the words alone when there is none (an automation's
    // wake). The fake echoes exactly what it was handed, so the echo is the
    // proof of what the model would see.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-steer-")),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(steer("f1", "t1", "cv-a", "fold this in", "[a new message]"));
    t.push(steer("f2", "t1", "cv-a", "a wake, unframed"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    // Each echo streams under ITS follow-up (the reply's own row).
    const echoOf = (turnId: string) =>
      t
        .of("event")
        .filter((m) => m.turnId === turnId && m.event.type === "text.delta")
        .map((m) => (m.event.type === "text.delta" ? m.event.text : ""))
        .filter((text) => text.startsWith("[steered: "));
    expect(echoOf("f1")).toEqual([
      "[steered: [a new message]\n\nfold this in]",
    ]);
    expect(echoOf("f2")).toEqual(["[steered: a wake, unframed]"]);
    expect(followUpsOf(t, "t1")).toEqual([
      { turnId: "f1", outcome: "joined" },
      { turnId: "f2", outcome: "joined" },
    ]);
  });

  it("a steer arriving BEFORE its turn's deliver drains at the first event", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-steer-")),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
    );

    // The same-batch race, worst ordering: the steer frame first.
    t.push(steer("f1", "t1", "cv-a", "early bird"));
    t.push(deliver("t1", "cv-a"));

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(followUpsOf(t, "t1")).toEqual([{ turnId: "f1", outcome: "joined" }]);
  });

  it("a steer whose target never runs is PRUNED silently — promotion owns it", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-steer-")),
      createFakeHarness(),
      t.transport,
    );

    // t-gone ended elsewhere (or never reached this container): its steer
    // parks, then the conversation's NEXT turn starts and prunes it.
    t.push(steer("f-orphan", "t-gone", "cv-a", "too late"));
    t.push(deliver("t2", "cv-a"));

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    // No outcome for the orphan: the supervisor never delivered it, so the
    // control plane's promotion path is its recovery — an outcome here
    // (either value) would be a lie.
    expect(followUpsOf(t, "t2")).toBeUndefined();
    const injected = t
      .of("event")
      .some(
        (m) =>
          m.event.type === "text.delta" && m.event.text.includes("too late"),
      );
    expect(injected).toBe(false);
  });

  it("degrades to queue-only when the harness lacks the capability", async () => {
    const base = createFakeHarness({ script: () => longScript() });
    // A steer-less harness: capability off, method absent — the profile is a
    // promise, and the supervisor must not exercise what is not declared.
    const startSession: Harness["startSession"] = async (options) => {
      const session = await base.startSession(options);
      const { steer: _steer, ...rest } = session;
      void _steer;
      return {
        ...rest,
        runTurn: session.runTurn.bind(session),
        abort: session.abort.bind(session),
      };
    };
    const harness: Harness = {
      ...base,
      capabilities: { ...base.capabilities, steer: false },
      startSession,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
    };

    const t = createTestTransport();
    const run = runSupervisor(config(home("sup-steer-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(steer("f1", "t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    // No steer happened, no outcome reported — the message stays the
    // control plane's to promote. And nothing crashed.
    expect(followUpsOf(t, "t1")).toBeUndefined();
  });

  it("ignores a message.joined for an id this supervisor never delivered", async () => {
    // MUTATION-PROOF for the supervisor's honor guard: an adapter that mints
    // confirmations for messages it was never handed must not reach the
    // terminal report — the control plane's settle fence is the second wall,
    // but the first is here.
    const base = createFakeHarness();
    const startSession: Harness["startSession"] = async (options) => {
      const session = await base.startSession(options);
      return {
        sessionRef: session.sessionRef,
        abort: session.abort.bind(session),
        steer: session.steer?.bind(session),
        async *runTurn(input) {
          yield { type: "turn.started" };
          // The forged confirmation, for an id nobody steered.
          yield { type: "message.joined", followUpId: "forged" };
          void input;
          yield { type: "turn.done" };
        },
      };
    };
    const harness: Harness = {
      ...base,
      startSession,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
    };

    const t = createTestTransport();
    const run = runSupervisor(config(home("sup-steer-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(followUpsOf(t, "t1")).toBeUndefined();
  });

  it("stores a joined follow-up's reply under the follow-up, before the turn closes", async () => {
    // The lost-reply bug at the supervisor: the agent answered the mid-turn
    // message, then kept working, and the turn kept only its closing words.
    // Now the reply is the follow-up's own `text`, sent under ITS id, ahead
    // of the turn's terminal frames; the turn's answer is untouched.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-steer-")),
      createFakeHarness({
        script: () => [
          ...longScript().slice(0, -1),
          { type: "tool.started", callId: "c1", name: "bash" },
          { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
          { type: "text.delta", text: "THE-FINAL-ANSWER", messageId: "m-end" },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(steer("f1", "t1", "cv-a", "fold this in"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    const texts = t
      .of("event")
      .filter((m) => m.event.type === "text")
      .map((m) => ({ turnId: m.turnId, event: m.event }));
    expect(texts).toEqual([
      {
        turnId: "f1",
        event: { type: "text", text: "[steered: fold this in]" },
      },
      { turnId: "t1", event: { type: "text", text: "THE-FINAL-ANSWER" } },
    ]);
    // Ordered ahead of the turn's terminal report, on the one socket, and
    // LIVE: ahead of the work the turn did after the injection,
    // not held for the terminal. The harness confirmed the join as it
    // happened, so the reply and the join reach the wire before the tool
    // call that followed them.
    const replyAt = t.sent.findIndex(
      (m) => m.kind === "event" && m.turnId === "f1",
    );
    const joinedAt = t.sent.findIndex(
      (m) => m.kind === "event" && m.event.type === "message.joined",
    );
    const laterToolAt = t.sent.findIndex(
      (m) => m.kind === "event" && m.event.type === "tool.started",
    );
    const resultAt = t.sent.findIndex((m) => m.kind === "turn.result");
    expect(replyAt).toBeGreaterThan(-1);
    // The join is on the wire BEFORE the first word of the reply: a reader
    // sees the message picked up, then the reply grow under it.
    expect(joinedAt).toBeGreaterThan(-1);
    expect(joinedAt).toBeLessThan(replyAt);
    expect(replyAt).toBeLessThan(laterToolAt);
    expect(replyAt).toBeLessThan(resultAt);
    // The reply never rides the wire's `message.joined`, and the harness's
    // `message.replied` has no wire form at all.
    expect(
      t
        .of("event")
        .filter((m) => m.event.type === "message.joined")
        .map((m) => m.event),
    ).toEqual([{ type: "message.joined", followUpId: "f1" }]);
    expect(
      t.of("event").some((m) => String(m.event.type) === "message.replied"),
    ).toBe(false);
  });

  it("keeps a reply that is the turn's closing words as the TURN's answer", async () => {
    // One message answering both: storing it under the follow-up would leave
    // the turn with no answer, so it stays where it was, said once.
    expect(
      await runScriptedSteer([
        { type: "message.joined", followUpId: "f1" },
        { type: "text.delta", text: "Both done.", messageId: "m1" },
        { type: "message.replied", followUpId: "f1", reply: "Both done." },
        { type: "turn.done" },
      ]),
    ).toEqual([{ turnId: "t1", event: { type: "text", text: "Both done." } }]);
  });

  it("ignores a reply for an id this supervisor never delivered", async () => {
    // A reply names a follow-up the harness never joined under this
    // supervisor (a forged or stale id): it is not stored under anything,
    // and the turn's answer is untouched. The delivered follow-up still
    // joins, with no reply of its own.
    expect(
      await runScriptedSteer([
        { type: "message.joined", followUpId: "f1" },
        { type: "text.delta", text: "Both done.", messageId: "m1" },
        { type: "message.replied", followUpId: "forged", reply: "Both done." },
        { type: "turn.done" },
      ]),
    ).toEqual([{ turnId: "t1", event: { type: "text", text: "Both done." } }]);
  });

  it("a delta tagged for an id this supervisor never delivered stays under the TURN", async () => {
    // The same honor guard on the live stream: an adapter cannot stream
    // words under a row it was never handed (a forged `replyTo`), and a
    // row not yet confirmed joined gets nothing either. MUTATION-PROOF: key
    // the wire delta on `replyTo` alone and "Both done." streams under
    // "forged" below.
    const base = createFakeHarness();
    const startSession: Harness["startSession"] = async (options) => {
      const session = await base.startSession(options);
      return {
        sessionRef: session.sessionRef,
        abort: session.abort.bind(session),
        steer: session.steer?.bind(session),
        async *runTurn(input) {
          void input;
          yield { type: "turn.started" };
          yield {
            type: "text.delta",
            text: "Both done.",
            messageId: "m1",
            replyTo: "forged",
          };
          yield { type: "turn.done" };
        },
      };
    };
    const harness: Harness = {
      ...base,
      startSession,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
    };
    const t = createTestTransport();
    const run = runSupervisor(config(home("sup-steer-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(
      t
        .of("event")
        .filter((m) => m.event.type === "text.delta")
        .map((m) => m.turnId),
    ).toEqual(["t1"]);
  });

  it("caps a runaway reply at the answer's own ceiling", async () => {
    // A reply is stored like an answer, so the same memory/wire guard
    // applies. MUTATION-PROOF: send it unsliced and the oversized text
    // reaches the transport whole.
    const huge = "r".repeat(MAX_ANSWER_CHARS + 50);
    const texts = await runScriptedSteer([
      { type: "message.joined", followUpId: "f1" },
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.finished", callId: "c1", name: "bash", output: "" },
      { type: "text.delta", text: "Done.", messageId: "m2" },
      { type: "message.replied", followUpId: "f1", reply: huge },
      { type: "turn.done" },
    ]);
    expect(texts).toEqual([
      {
        turnId: "f1",
        event: { type: "text", text: huge.slice(0, MAX_ANSWER_CHARS) },
      },
      { turnId: "t1", event: { type: "text", text: "Done." } },
    ]);
  });

  it("NEVER delivers one steer twice — the inline arm and the turn drain serialize", async () => {
    // MUTATION-PROOF for the steerDrain chain: unserialized, the reader
    // loop's inline arm and the turn's first-event drain both pick the same
    // parked entry while the first RPC is still in flight, and the user's
    // words are injected twice into the live run.
    const base = createFakeHarness();
    const steerCalls = new Map<string, number>();
    const startSession: Harness["startSession"] = async (options) => {
      const session = await base.startSession(options);
      return {
        sessionRef: session.sessionRef,
        abort: session.abort.bind(session),
        steer: async (input: { id: string; message: string }) => {
          steerCalls.set(input.id, (steerCalls.get(input.id) ?? 0) + 1);
          // A slow daemon RPC — the overlap window the chain must close.
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
        async *runTurn(input) {
          yield { type: "turn.started" };
          void input;
          for (let i = 0; i < 60; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3));
            yield { type: "text.delta", text: `c${i}` };
          }
          yield { type: "turn.done" };
        },
      };
    };
    const harness: Harness = {
      ...base,
      startSession,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
    };

    const t = createTestTransport();
    const run = runSupervisor(config(home("sup-steer-")), harness, t.transport);

    // Parked BEFORE the deliver, so the turn's first-event drain starts the
    // slow RPC for f1 — then a second frame arrives mid-flight and the
    // inline arm races it.
    t.push(steer("f1", "t1", "cv-a", "once only"));
    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(steer("f2", "t1", "cv-a", "the racer"));

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(steerCalls.get("f1")).toBe(1);
    expect(steerCalls.get("f2")).toBe(1);
  });

  it("reports missed for a delivered steer the run never confirmed", async () => {
    const base = createFakeHarness();
    // A harness that ACCEPTS steers but never injects them (its runTurn is
    // too short) — delivered-but-unconfirmed is exactly `missed`.
    const startSession: Harness["startSession"] = async (options) => {
      const session = await base.startSession(options);
      const pending: string[] = [];
      return {
        sessionRef: session.sessionRef,
        abort: session.abort.bind(session),
        steer: async (input: { id: string; message: string }) => {
          pending.push(input.id);
        },
        async *runTurn(input) {
          yield { type: "turn.started" };
          void input;
          // A couple of gaps so the steer has time to be delivered mid-run.
          for (let i = 0; i < 40; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            yield { type: "text.delta", text: `c${i}` };
          }
          yield { type: "turn.done" };
        },
      };
    };
    const harness: Harness = {
      ...base,
      startSession,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
    };

    const t = createTestTransport();
    const run = runSupervisor(config(home("sup-steer-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(steer("f1", "t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(followUpsOf(t, "t1")).toEqual([{ turnId: "f1", outcome: "missed" }]);
  });

  it("the control plane's SYNTHETIC ceiling-warning id rides the same path", async () => {
    // due-work's approaching-ceiling arm steers a wrap-up warning with a
    // namespaced id (`ceiling-warning:<turnId>`, no row behind it). The
    // supervisor must treat the id as the opaque token it is: inject the
    // message and echo the id back on turn.result — where the control
    // plane's settle provably no-ops (follow-ups.pg.test.ts).
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-steer-ceiling-")),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    t.push(
      steer(ceilingWarningSteerId("t1"), "t1", "cv-a", "[system] wrap up now"),
    );

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(followUpsOf(t, "t1")).toEqual([
      { turnId: ceilingWarningSteerId("t1"), outcome: "joined" },
    ]);
    const injected = t
      .of("event")
      .some(
        (m) =>
          m.turnId === "t1" &&
          m.event.type === "text.delta" &&
          m.event.text.includes("[system] wrap up now"),
      );
    // Streamed under the TURN: no row behind the id, so its reply deltas
    // never re-key to the synthetic id (a stream the control plane could
    // not fence to a row). MUTATION-PROOF: drop the platform-steer guard in
    // `replyTargetOf` and the echo goes out under the warning id.
    expect(injected).toBe(true);
    expect(
      t.of("event").some((m) => m.turnId === ceilingWarningSteerId("t1")),
    ).toBe(false);
    // No row behind the id, so nothing to store an answer under: the
    // agent's reply to the platform's warning stays the TURN's own words,
    // never a `text` sent under the synthetic id (a write the control
    // plane would refuse, losing the wrap-up). MUTATION-PROOF: drop the
    // platform-steer guard and the reply goes out under the warning id.
    const texts = t
      .of("event")
      .filter((m) => m.event.type === "text")
      .map((m) => m.turnId);
    expect(texts).toEqual(["t1"]);
  });
});

/**
 * A follow-up WITH files steers with them: its parts reach the socket ahead
 * of its frame and apply on the sync chain, the steer waits for them to
 * land, then hands the inlineable images to the harness WITH the words. The
 * fake harness echoes each image's media type and size in its reply, which
 * is how these tests read what the "model" was actually handed.
 */
describe("steering a follow-up that carries files", () => {
  /** A real file, chunked into the parts a runner would stream. */
  const fileParts = (
    followUpId: string,
    name: string,
    mimeType: string,
    bytes: Buffer,
  ) => {
    const entry = {
      id: `att-${name}`,
      path: `attachments/${followUpId}/${name}`,
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const part: SupervisorWorkItem = {
      kind: "attachment.part",
      turnId: followUpId,
      attachmentId: entry.id,
      path: entry.path,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      part: 1,
      of: 1,
      dataBase64: bytes.toString("base64"),
    };
    return { entry, part };
  };
  const PNG = Buffer.from("fake-png-bytes");

  /**
   * A supervisor whose sync chain is HELD: a home sync is in flight and its
   * apply waits on `release`, so a file part queued behind it lands only
   * once the test lets it. The steer for that file must wait just as long,
   * and nothing else may.
   */
  const startWithHeldSync = (homeDir: string, t: TestTransport) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const run = runSupervisor(
      config(homeDir),
      createFakeHarness({ script: () => longScript() }),
      t.transport,
      { applySync: () => held },
    );
    return { run, release };
  };
  const homeSync: SupervisorWorkItem = {
    kind: "skills.changed",
    generation: 1,
    part: 1,
    of: 1,
    files: [],
  };

  const replyOf = (t: TestTransport, followUpId: string) =>
    t
      .of("event")
      .flatMap((m) =>
        m.turnId === followUpId && m.event.type === "text"
          ? [m.event.text]
          : [],
      )
      .join("");

  it("waits for the image to land on disk, then steers the words WITH it into the live run", async () => {
    // MUTATION-TESTED: hand an entry over before its files land and the
    // image is not on disk to inline; never drain again on the landing and
    // the steer never goes at all.
    const homeDir = home("sup-steer-files-");
    const t = createTestTransport();
    const { run, release } = startWithHeldSync(homeDir, t);
    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );

    const image = fileParts("f1", "photo.png", "image/png", PNG);
    const pdf = fileParts("f1", "spec.pdf", "application/pdf", PNG);
    // A home sync is mid-apply when the files arrive, so they queue behind.
    t.push(homeSync);
    t.push(image.part);
    t.push(pdf.part);
    t.push(
      steer("f1", "t1", "cv-a", "what is this?", undefined, [
        image.entry,
        pdf.entry,
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replyOf(t, "f1")).toBe("");
    release();

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(followUpsOf(t, "t1")).toEqual([{ turnId: "f1", outcome: "joined" }]);
    // The image rode the steer (its base64 length is what the fake echoes);
    // the PDF is not inlineable, so it sits on disk for the read tool only.
    const base64Length = PNG.toString("base64").length;
    expect(replyOf(t, "f1")).toBe(
      `[steered: what is this? [image image/png ${base64Length}]]`,
    );
    expect(existsSync(join(homeDir, image.entry.path))).toBe(true);
    expect(existsSync(join(homeDir, pdf.entry.path))).toBe(true);
  });

  it("a Stop is NEVER held behind a follow-up's file write", async () => {
    // MUTATION-TESTED: make the drain wait for an entry's files and the
    // reader (which awaits it) holds the abort behind the file write.
    const t = createTestTransport();
    const { run, release } = startWithHeldSync(home("sup-steer-abort-"), t);
    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => t.of("event").some((m) => m.event.type === "text.delta"),
      "the turn to start streaming",
    );
    const { entry, part } = fileParts("f1", "photo.png", "image/png", PNG);
    t.push(homeSync);
    t.push(part);
    t.push(steer("f1", "t1", "cv-a", "what is this?", undefined, [entry]));
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });

    // The run stops while the file is STILL held.
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    expect(t.of("turn.result")[0]).toMatchObject({
      turnId: "t1",
      status: "aborted",
    });
    release();
    await t.finish(run);
  });

  it("a follow-up with files that reaches the turn's FIRST-event drain never stalls the run's own events while it waits", async () => {
    // MUTATION-TESTED: make the drain wait for an entry's files and the
    // run's first event (which awaits it) freezes behind the file write.
    const t = createTestTransport();
    let releaseSync!: () => void;
    const held = new Promise<void>((resolve) => (releaseSync = resolve));
    // The run's first event waits on `openRun`, so the follow-up and its
    // (held) file are queued before the turn's first-event drain runs.
    let openRun!: () => void;
    const runGate = new Promise<void>((resolve) => (openRun = resolve));
    let runStarted = false;
    const base = createFakeHarness({ script: () => longScript() });
    const harness: Harness = {
      ...base,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
      startSession: async (options) => {
        const session = await base.startSession(options);
        return {
          sessionRef: session.sessionRef,
          abort: session.abort.bind(session),
          steer: session.steer?.bind(session),
          async *runTurn(input) {
            runStarted = true;
            await runGate;
            yield* session.runTurn(input);
          },
        };
      },
    };
    const run = runSupervisor(
      config(home("sup-steer-early-")),
      harness,
      t.transport,
      { applySync: () => held },
    );
    t.push(deliver("t1", "cv-a"));
    await t.until(() => runStarted, "the run to begin");
    const { entry, part } = fileParts("f1", "photo.png", "image/png", PNG);
    t.push(homeSync);
    t.push(part);
    t.push(steer("f1", "t1", "cv-a", "what is this?", undefined, [entry]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    openRun();

    // The run streams to its end while the file is STILL held.
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    expect(t.of("turn.result")[0]).toMatchObject({
      turnId: "t1",
      status: "done",
    });
    releaseSync();
    await t.finish(run);
  });

  it("a follow-up whose files land after its turn ended is left to promotion, never injected into a later run", async () => {
    const t = createTestTransport();
    const steered: string[] = [];
    const base = createFakeHarness({ script: () => [{ type: "turn.done" }] });
    const harness: Harness = {
      ...base,
      onFailure: base.onFailure.bind(base),
      dispose: base.dispose.bind(base),
      startSession: async (options) => {
        const session = await base.startSession(options);
        return {
          sessionRef: session.sessionRef,
          abort: session.abort.bind(session),
          runTurn: session.runTurn.bind(session),
          steer: async (input) => {
            steered.push(input.id);
            return session.steer?.(input);
          },
        };
      },
    };
    const run = runSupervisor(
      config(home("sup-steer-late-")),
      harness,
      t.transport,
    );
    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "t1 to end");
    const { entry, part } = fileParts("f1", "photo.png", "image/png", PNG);
    t.push(part);
    t.push(steer("f1", "t1", "cv-a", "too late", undefined, [entry]));
    t.push(deliver("t2", "cv-a", "the next message"));
    await t.until(() => t.of("turn.result").length === 2, "t2 to end");
    await t.finish(run);

    expect(steered).toEqual([]);
  });
});
