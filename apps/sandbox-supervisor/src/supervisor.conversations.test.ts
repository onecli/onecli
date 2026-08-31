import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  Harness,
  SupervisorMessage,
  SupervisorTransport,
  WorkItem,
} from "@onecli/agent-protocol";
import {
  createFakeHarness,
  createFakeSessionStore,
  type FakeSessionStore,
} from "./harness/fake";
import type { ProcessManager } from "./processes/manager";
import { runSupervisor } from "./supervisor";

/**
 * The two laws the step-4 restructure exists for:
 *
 * 1. A harness session **per conversation** — an agent has one computer but
 *    many conversations, and their contexts must not bleed.
 * 2. An abort that lands **while a turn is running**. The old shape awaited
 *    each turn inside the read loop, so an abort frame could only be read
 *    after the turn it was meant to cancel had already ended.
 */

const config = (homeDir: string) => ({
  homeDir,
  model: undefined,
  effort: undefined,
  instructions: "You are the test agent.",
  agentName: "Ada",
  harness: "fake",
  runnerWsUrl: undefined,
  bootstrapToken: undefined,
});

const home = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A transport the test drives by hand: push work in, read messages out. */
const createTestTransport = () => {
  const sent: SupervisorMessage[] = [];
  const queue: WorkItem[] = [];
  let notify: (() => void) | undefined;
  let closes = 0;
  /**
   * Anything written after `close()` — a real socket has already gone by then,
   * so these are messages the control plane never receives. Kept separately so
   * a test can assert there are none rather than trusting call order.
   */
  const lost: SupervisorMessage[] = [];

  const api = {
    sent,
    lost,
    /** How many times the supervisor released the channel. */
    closeCount: () => closes,
    push(item: WorkItem) {
      queue.push(item);
      notify?.();
      notify = undefined;
    },
    /** Messages of one kind, in order. */
    of<K extends SupervisorMessage["kind"]>(kind: K) {
      return sent.filter(
        (m): m is Extract<SupervisorMessage, { kind: K }> => m.kind === kind,
      );
    },
    /** Poll until a condition holds — no fixed sleeps, so no flake. */
    async until(predicate: () => boolean, label: string) {
      for (let i = 0; i < 400; i += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    /** Drain the loop and wait for the supervisor to return. */
    async finish(run: Promise<void>) {
      api.push({ kind: "shutdown" });
      await run;
    },
    transport: {
      async *incoming(): AsyncIterable<WorkItem> {
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
        if (closes > 0) lost.push(message);
        sent.push(message);
      },
      close() {
        closes += 1;
        return Promise.resolve();
      },
    } satisfies SupervisorTransport,
  };
  return api;
};

const deliver = (
  turnId: string,
  conversationId: string,
  extra: { message?: string; resumeSessionRef?: string } = {},
): WorkItem => ({
  kind: "turn.deliver",
  turnId,
  conversationId,
  message: extra.message ?? "hello",
  ...(extra.resumeSessionRef && { resumeSessionRef: extra.resumeSessionRef }),
});

type TestTransport = ReturnType<typeof createTestTransport>;

const sessionRefs = (t: TestTransport) =>
  t.of("turn.result").map((r) => r.sessionRef);

/** A long turn: enough events that an abort has room to land inside it. */
const LONG_SCRIPT_LENGTH = 60;
const longScript = (): AgentEvent[] =>
  Array.from({ length: LONG_SCRIPT_LENGTH }, (_, i) => ({
    type: "text.delta" as const,
    text: `chunk-${i}`,
  }));

const deltasOf = (t: TestTransport, turnId: string) =>
  t
    .of("event")
    .filter((m) => m.turnId === turnId && m.event.type === "text.delta");

describe("one harness session per conversation", () => {
  it("gives two conversations two DIFFERENT sessions", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-conv-")),
      createFakeHarness(),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    t.push(deliver("t2", "cv-b"));
    await t.until(() => t.of("turn.result").length === 2, "both turns");
    await t.finish(run);

    const [a, b] = sessionRefs(t);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Two conversations, two sessions — contexts must not bleed.
    expect(a).not.toBe(b);
  });

  it("REUSES one session across turns of the same conversation", async () => {
    const store = createFakeSessionStore();
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-conv-")),
      createFakeHarness({ store }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { message: "one" }));
    await t.until(() => t.of("turn.result").length === 1, "first turn");
    t.push(deliver("t2", "cv-a", { message: "two" }));
    await t.until(() => t.of("turn.result").length === 2, "second turn");
    await t.finish(run);

    const [first, second] = sessionRefs(t);
    expect(first).toBe(second);
    // One session that actually accumulated both turns, not two that happen
    // to share a name.
    expect(store.size).toBe(1);
    expect(first && store.get(first)?.turnsRun).toBe(2);
  });

  it("starts sessions lazily — none before the first turn", async () => {
    const store = createFakeSessionStore();
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-conv-")),
      createFakeHarness({ store }),
      t.transport,
    );

    await t.until(() => t.of("ready").length === 1, "ready");
    // Ready follows the home render, not a session start: a sandbox is
    // deliverable before it has paid for any conversation.
    expect(store.size).toBe(0);
    await t.finish(run);
  });
});

describe("resume", () => {
  /**
   * Run one supervisor to completion over a shared store, returning the
   * session ref each conversation ended up with. Two conversations, so the
   * refs the fake mints are distinguishable from a fresh run's (whose counter
   * restarts at 1) — otherwise "resumed" and "created new" would be the same
   * string and the assertion would prove nothing.
   */
  const seedTwoConversations = async (store: FakeSessionStore) => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-resume-")),
      createFakeHarness({ store }),
      t.transport,
    );
    t.push(deliver("t1", "cv-a", { message: "a" }));
    await t.until(() => t.of("turn.result").length === 1, "cv-a turn");
    t.push(deliver("t2", "cv-b", { message: "b" }));
    await t.until(() => t.of("turn.result").length === 2, "cv-b turn");
    await t.finish(run);
    return sessionRefs(t);
  };

  it("attaches a conversation to its PRIOR session, not a fresh one", async () => {
    const store = createFakeSessionStore();
    const [, secondRef] = await seedTwoConversations(store);
    expect(secondRef).toBeDefined();

    // A new supervisor over the same store — as after a container restart.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-resume-")),
      createFakeHarness({ store }),
      t.transport,
    );
    t.push(deliver("t3", "cv-b", { resumeSessionRef: secondRef }));
    await t.until(() => t.of("turn.result").length === 1, "resumed turn");
    await t.finish(run);

    const [resumed] = sessionRefs(t);
    // A fresh session here would have been minted as the new harness's #1.
    expect(resumed).toBe(secondRef);
    expect(store.size).toBe(2);
    expect(secondRef && store.get(secondRef)?.turnsRun).toBe(2);
  });

  it("DROPS the ref for a harness that cannot resume", async () => {
    // The fake rejects an unknown ref, so a harness that ignores its own
    // `resume: false` capability would fail this turn outright.
    const base = createFakeHarness();
    const noResume: Harness = {
      ...base,
      capabilities: { ...base.capabilities, resume: false },
    };
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-resume-")),
      noResume,
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { resumeSessionRef: "from-another-harness" }));
    await t.until(() => t.of("turn.result").length === 1, "turn");
    await t.finish(run);

    const [result] = t.of("turn.result");
    expect(result?.status).toBe("done");
    expect(result?.sessionRef).not.toBe("from-another-harness");
  });

  it("reports the failure rather than hanging when resume is refused", async () => {
    // Same input, but a harness that CAN resume and is handed a ref its store
    // never had: the turn must come back failed, not silently vanish.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-resume-")),
      createFakeHarness(),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { resumeSessionRef: "does-not-exist" }));
    await t.until(() => t.of("turn.result").length === 1, "failed turn");
    await t.finish(run);

    const [result] = t.of("turn.result");
    expect(result?.status).toBe("failed");
    expect(result?.error).toContain("unknown session");
  });
});

describe("the turn-liveness heartbeat", () => {
  it("beats for the whole life of a turn and stops with it", async () => {
    // The control plane's stall arm fails a running turn whose heartbeat
    // goes silent — so the beat must run whatever the turn is doing, and
    // must NOT outlive the turn (a beat for a finished turn is an orphan's,
    // and the API refuses it; sending one anyway is noise on every idle
    // conversation).
    const t = createTestTransport();
    const run = runSupervisor(
      { ...config(home("sup-beat-")), progressIntervalMs: 10 },
      createFakeHarness({ script: longScript }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { message: "go" }));
    await t.until(() => t.of("progress").length >= 2, "two heartbeats");
    // Every beat names the turn it vouches for.
    for (const beat of t.of("progress")) {
      expect(beat).toEqual({
        kind: "progress",
        turnId: "t1",
        conversationId: "cv-a",
      });
    }

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    const atClose = t.of("progress").length;
    // The timer died in the turn's finally: no beat lands after the close.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.of("progress").length).toBe(atClose);
    await t.finish(run);
  });
});

describe("abort while a turn is running", () => {
  it("lands mid-turn — the regression the restructure exists to prevent", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-abort-")),
      createFakeHarness({ script: longScript }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { message: "go" }));
    // Wait for the turn to be genuinely underway, then interrupt it.
    await t.until(() => deltasOf(t, "t1").length >= 3, "the turn to start");
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    // Cut short: the abort took effect long before the script ran out.
    expect(deltasOf(t, "t1").length).toBeLessThan(LONG_SCRIPT_LENGTH);
    // And it ended coherently — a turn.done tail, not a hang or a dangling
    // stream the control plane would have to reclaim.
    const types = t.of("event").map((m) => m.event.type);
    expect(types.at(-1)).toBe("turn.done");
  });

  it("does not touch a DIFFERENT conversation's running turn", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-abort-")),
      createFakeHarness({ script: longScript }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { message: "go" }));
    t.push(deliver("t2", "cv-b", { message: "go" }));
    await t.until(() => deltasOf(t, "t2").length >= 3, "cv-b to start");
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });

    await t.until(() => t.of("turn.result").length === 2, "both turns");
    await t.finish(run);

    // cv-a was cut short; cv-b ran its script to the end.
    expect(deltasOf(t, "t1").length).toBeLessThan(LONG_SCRIPT_LENGTH);
    expect(deltasOf(t, "t2").length).toBe(LONG_SCRIPT_LENGTH);
  });

  it("reports the turn as ABORTED, not done", async () => {
    // An abort ends the harness stream cleanly, so "did it finish without
    // throwing" cannot tell a cancelled turn from a completed one. Reporting
    // `done` here would make the control plane's `aborted` status unreachable
    // for the only path that can actually produce it.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-abort-")),
      createFakeHarness({ script: longScript }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { message: "go" }));
    await t.until(() => deltasOf(t, "t1").length >= 3, "the turn to start");
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });
    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(t.of("turn.result")[0]?.status).toBe("aborted");
  });

  it("honours an abort that arrives BEFORE the session finished starting", async () => {
    // Session startup is the slow part (a harness boots a process), and the
    // control plane's abort request is one-shot — so an abort dropped in that
    // window is gone, and the turn runs to completion against the user's
    // explicit instruction.
    const slowHarness = createFakeHarness();
    const startSession = slowHarness.startSession.bind(slowHarness);
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-abort-")),
      {
        ...slowHarness,
        startSession: async (options) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return startSession(options);
        },
      },
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { message: "go" }));
    // Well inside the startup window.
    await new Promise((resolve) => setTimeout(resolve, 10));
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });

    await t.until(() => t.of("turn.result").length === 1, "the turn to end");
    await t.finish(run);

    expect(t.of("turn.result")[0]?.status).toBe("aborted");
    // And it never ran: no events were produced at all.
    expect(deltasOf(t, "t1")).toHaveLength(0);
  });

  it("ignores an abort for a turn that is no longer the one running", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-abort-")),
      createFakeHarness(),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "first turn");
    // t1 has finished; a late abort must not cancel whatever comes next.
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });
    t.push(deliver("t2", "cv-a", { message: "again" }));
    await t.until(() => t.of("turn.result").length === 2, "second turn");
    await t.finish(run);

    expect(t.of("turn.result").every((r) => r.status === "done")).toBe(true);
  });

  it("ignores an abort for an unknown conversation", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-abort-")),
      createFakeHarness(),
      t.transport,
    );

    t.push({ kind: "turn.abort", turnId: "nope", conversationId: "cv-ghost" });
    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the real turn");
    await t.finish(run);

    expect(t.of("turn.result")[0]?.status).toBe("done");
  });
});

describe("scheduling", () => {
  it("runs turns of ONE conversation in order, never overlapping", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-serial-")),
      createFakeHarness(),
      t.transport,
    );

    // Both queued before either can finish: the queue, not the sender, is
    // what keeps them ordered.
    t.push(deliver("t1", "cv-a", { message: "one" }));
    t.push(deliver("t2", "cv-a", { message: "two" }));
    await t.until(() => t.of("turn.result").length === 2, "both turns");
    await t.finish(run);

    const order = t.of("event").map((m) => m.turnId);
    // Every event of t1 precedes every event of t2 — no interleaving.
    expect(order.lastIndexOf("t1")).toBeLessThan(order.indexOf("t2"));
  });

  it("runs turns of DIFFERENT conversations concurrently", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-serial-")),
      createFakeHarness({ script: longScript }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    t.push(deliver("t2", "cv-b"));
    await t.until(() => t.of("turn.result").length === 2, "both turns");
    await t.finish(run);

    // Interleaved, which serialization across conversations would forbid.
    const order = t.of("event").map((m) => m.turnId);
    expect(order.lastIndexOf("t1")).toBeGreaterThan(order.indexOf("t2"));
  });

  it("keeps serving a conversation after a transport write throws", async () => {
    // The per-conversation chain is a promise tail. A rejection poisons it:
    // every later `.then` short-circuits, so the conversation silently stops
    // running turns for the life of the container. `transport.send` is called
    // from runTurn's try AND its catch, and a write to a dying socket throws.
    let failNext = false;
    const t = createTestTransport();
    const flaky: SupervisorTransport = {
      incoming: t.transport.incoming,
      send: (message) => {
        if (failNext && message.kind === "turn.result") {
          failNext = false;
          throw new Error("socket went away");
        }
        t.transport.send(message);
      },
      close: () => t.transport.close(),
    };
    const run = runSupervisor(
      config(home("sup-chain-")),
      createFakeHarness(),
      flaky,
    );

    failNext = true;
    t.push(deliver("t1", "cv-a", { message: "one" }));
    // t1's result throws on the way out; t2 must still run.
    t.push(deliver("t2", "cv-a", { message: "two" }));
    await t.until(
      () => t.of("turn.result").some((r) => r.turnId === "t2"),
      "the second turn",
    );
    await t.finish(run);

    // The conversation kept working — which a poisoned chain would prevent
    // silently, forever.
    expect(t.of("turn.result").map((r) => r.turnId)).toContain("t2");
  });

  it("lets in-flight turns finish reporting before shutdown", async () => {
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-serial-")),
      createFakeHarness({ script: longScript }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => deltasOf(t, "t1").length >= 3, "the turn to start");
    // Shutdown arrives mid-turn: the result must still be reported, or the
    // control plane would only learn of it via the stale-turn reclaim.
    await t.finish(run);

    expect(t.of("turn.result")).toHaveLength(1);
  });

  it("releases the channel once the loop ends", async () => {
    // Without this the supervisor stops looping but keeps an open socket, and
    // an open socket keeps Node's event loop alive — a container running with
    // nothing left to do, which reconcile cannot see and nothing reaps.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-close-")),
      createFakeHarness(),
      t.transport,
    );

    expect(t.closeCount()).toBe(0);
    await t.finish(run);
    expect(t.closeCount()).toBe(1);
    // And an ORDINARY shutdown is not a failure. Disposing the harness closes
    // the very connection whose loss means "it died", so the mirror-image bug
    // — recycling the sandbox on every clean stop — is one missing guard away.
    expect(t.of("unhealthy")).toHaveLength(0);
  });
});

describe("the answer survives the turn", () => {
  /** Every text the supervisor sent for a turn, in wire order. */
  const textsOf = (t: TestTransport, turnId: string) =>
    t
      .of("event")
      .filter((m) => m.turnId === turnId && m.event.type === "text")
      .map((m) => (m.event.type === "text" ? m.event.text : ""));

  const kindsOf = (t: TestTransport, turnId: string) =>
    t
      .of("event")
      .filter((m) => m.turnId === turnId)
      .map((m) => m.event.type);

  it("emits the whole answer once, coalesced from the deltas", async () => {
    // The deltas are ephemeral by design, so without this the transcript
    // records that a turn happened and what it touched — and not one word of
    // what it said. A reader who refreshes would lose every reply.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "text.delta", text: "Hello" },
          { type: "text.delta", text: ", world" },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual(["Hello, world"]);
  });

  it("puts the answer BEFORE the terminal event", async () => {
    // `seq` is assigned in arrival order, so an answer emitted after
    // `turn.done` would render below the marker saying the turn ended.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "text.delta", text: "done thinking" },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    const kinds = kindsOf(t, "t1");
    expect(kinds.indexOf("text")).toBeLessThan(kinds.indexOf("turn.done"));
  });

  it("keeps a PARTIAL answer when the turn fails mid-stream", async () => {
    // What the user watched arrive is what the transcript owes them, even
    // when the turn did not finish.
    const t = createTestTransport();
    const harness = createFakeHarness({ script: () => longScript() });
    const run = runSupervisor(
      config(home("sup-answer-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => deltasOf(t, "t1").length >= 3, "the turn to start");
    harness.simulateFailure("harness connection closed");
    await run;

    const [answer] = textsOf(t, "t1");
    expect(answer).toBeTruthy();
    expect(answer).toContain("chunk-0");
    expect(t.of("turn.result")[0]?.status).toBe("failed");
  });

  it("says nothing when there was nothing to say", async () => {
    // A turn that only ran tools must not add an empty row to the transcript.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "tool.started", callId: "c1", name: "bash" },
          { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual([]);
  });

  it("drops narration before a tool batch — the last message is the answer", async () => {
    // Distinct assistant messages within one turn used to be JOINED (first
    // glued mid-sentence, then separated by a blank line). Both were wrong
    // about what an answer IS: text before a tool call is the agent
    // narrating its work, and publishing it as part of the reply produced
    // the multi-screen chat walls seen live (2026-08-31). The narration
    // still streams as deltas; only the closing message is the record.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "text.delta", text: "Part one." },
          { type: "tool.started", callId: "c1", name: "bash" },
          { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
          { type: "text.delta", text: "Part two." },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual(["Part two."]);
  });

  it("keeps a message whole when the model thinks MID-sentence", async () => {
    // Thinking is NOT a message boundary. Reasoning interleaves inside one
    // message — the vendor protocol says so itself by giving reasoning its
    // own start/stop (`reasoning_done`) beside the text stream — so treating
    // it as a boundary would publish "the retry loop." and silently drop the
    // half of the sentence that names what broke.
    //
    // MUTATION-PROOF: add `thinking.delta` back to the boundary set and this
    // fails with the truncated fragment.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "text.delta", text: "The root cause is " },
          { type: "thinking.delta", text: "how do I phrase this" },
          { type: "text.delta", text: "the retry loop." },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual(["The root cause is the retry loop."]);
  });

  it("still drops narration when a tool call sits inside the thinking", async () => {
    // The two signals together: reasoning does not break the message, but
    // the tool call between the two texts does.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "text.delta", text: "Let me look." },
          { type: "thinking.delta", text: "which file" },
          { type: "tool.started", callId: "c1", name: "bash" },
          { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
          { type: "thinking.delta", text: "now I know" },
          { type: "text.delta", text: "It was the retry loop." },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual(["It was the retry loop."]);
  });

  it("never opens the answer with a separator", async () => {
    // A tool batch before the first word is not a boundary INSIDE the
    // answer — a leading blank line would also break the empty-answer law
    // upstream of it.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "tool.started", callId: "c1", name: "bash" },
          { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
          { type: "text.delta", text: "Only part." },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual(["Only part."]);
  });

  it("adjacent deltas of one message never gain a separator", async () => {
    // The boundary is an interleaved event, not the delta seam itself.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-answer-")),
      createFakeHarness({
        script: () => [
          { type: "text.delta", text: "One " },
          { type: "text.delta", text: "message." },
          { type: "turn.done" },
        ],
      }),
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(textsOf(t, "t1")).toEqual(["One message."]);
  });
});

describe("a harness that dies takes the sandbox with it", () => {
  it("reports the sandbox unhealthy and stops taking work", async () => {
    // The failure this exists for: the jcode process died mid-turn, and from
    // then on EVERY message failed with "harness connection closed" —
    // including the first message of a brand-new conversation. The container
    // ran, the control channel stayed connected, the control plane read
    // `running`, so nothing recovered it. Ever.
    const t = createTestTransport();
    const harness = createFakeHarness();
    const run = runSupervisor(config(home("sup-dead-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the healthy turn");

    harness.simulateFailure("harness connection closed");
    await run;

    const [unhealthy] = t.of("unhealthy");
    expect(unhealthy?.reason).toBe("harness connection closed");
    // The loop ended on its own — nobody sent `shutdown` — and the channel was
    // released, which is what ends the container.
    expect(t.closeCount()).toBe(1);
  });

  it("reports an in-flight turn's failure BEFORE the channel closes", async () => {
    // Order is the whole point: the turn that was running when the harness
    // died must reach a terminal state on the wire, or its conversation stays
    // blocked behind the active-turn index until the control plane's turn
    // ceiling. Closing the channel first would lose exactly that message.
    const t = createTestTransport();
    const harness = createFakeHarness({ script: longScript });
    const run = runSupervisor(config(home("sup-dead-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(() => deltasOf(t, "t1").length >= 3, "the turn to start");
    harness.simulateFailure("harness connection closed");
    await run;

    const failed = t.of("turn.result").find((r) => r.turnId === "t1");
    expect(failed?.status).toBe("failed");
    // A death AFTER the stream opened is classified as a restart — observable
    // work may exist, so the control plane must surface it, never revive it.
    expect(failed?.errorCode).toBe("agent_restarted");
    // Nothing was written to a channel that had already been released.
    expect(t.lost).toEqual([]);
  });

  it("classifies a LAUNCH failure as agent_start_failed", async () => {
    // The cold-boot shape: the harness binary dies before the turn's stream
    // ever opens — zero observable work. The code is what licenses the
    // control plane's invisible one-shot revival, so it must be exactly
    // `agent_start_failed`, and the raw error must still ride beside it for
    // logs and old control planes.
    const t = createTestTransport();
    const harness = createFakeHarness();
    harness.failNextStartSession("harness launch failed: spawn ENOENT");
    const run = runSupervisor(config(home("sup-dead-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await run;

    const failed = t.of("turn.result").find((r) => r.turnId === "t1");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("agent_start_failed");
    expect(failed?.error).toContain("harness launch failed");
    expect(t.of("unhealthy")).toHaveLength(1);
  });

  it("does NOT report unhealthy for an ordinary turn failure", async () => {
    // A session that cannot be resumed is one conversation's problem. Treating
    // it as a dead harness would recycle a perfectly good container — and, on
    // a ref that is permanently stale, recycle it on every retry forever.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-dead-")),
      createFakeHarness(),
      t.transport,
    );

    t.push(deliver("t1", "cv-a", { resumeSessionRef: "does-not-exist" }));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    expect(t.of("turn.result")[0]?.status).toBe("failed");
    // And no failure CODE either: the harness is alive, so this failure must
    // not be dressed as a death — a code here would let the control plane
    // rewrite a real, actionable error into restart copy.
    expect(t.of("turn.result")[0]?.errorCode).toBeUndefined();
    expect(t.of("unhealthy")).toHaveLength(0);
  });
});

describe("a model-provider refusal on a live harness", () => {
  const REFUSAL =
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit reached"}}';

  it("earns the model_provider_error code, with the raw refusal beside it", async () => {
    // The one live-harness failure a person can fix: the terminal error is
    // the provider refusing (limit, credits, key). The CODE lets the control
    // plane store canonical copy; the raw text rides beside it for the
    // server log (and an old control plane's raw passthrough).
    const t = createTestTransport();
    const harness = createFakeHarness({
      script: () => [{ type: "error", message: REFUSAL }],
    });
    const run = runSupervisor(
      config(home("sup-refusal-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("model_provider_error");
    expect(failed?.error).toBe(REFUSAL);
    // A refusal is one turn's problem, never a dead harness.
    expect(t.of("unhealthy")).toHaveLength(0);
  });

  it("keeps a non-refusal terminal error uncoded — no error field either", async () => {
    // The passthrough contract: anything the classifier does not positively
    // recognize keeps today's shape (no code, no turn.result error; the
    // transcript's own error event is the witness), so canonical copy can
    // never paper over an unrecognized failure.
    const t = createTestTransport();
    const harness = createFakeHarness({
      script: () => [
        { type: "error", message: "something unrecognizable went wrong" },
      ],
    });
    const run = runSupervisor(
      config(home("sup-refusal-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBeUndefined();
    expect(failed?.error).toBeUndefined();
  });

  it("truncates the raw refusal at the source — the terminal frame must deliver", async () => {
    // An unbounded harness error could exceed the runner WS server's frame
    // cap, which does not truncate — it drops the frame and kills the
    // socket, losing the turn's close entirely. Same law as the unhealthy
    // reason: slice at the sender.
    const t = createTestTransport();
    const harness = createFakeHarness({
      script: () => [
        { type: "error", message: `${REFUSAL} ${"x".repeat(300_000)}` },
      ],
    });
    const run = runSupervisor(
      config(home("sup-refusal-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    const [failed] = t.of("turn.result");
    expect(failed?.errorCode).toBe("model_provider_error");
    expect(failed?.error?.length).toBe(2000);
  });

  it("classifies a refusal that arrives as a THROW, not a stream event", async () => {
    // The catch arm consults the same classifier: a live-harness throw whose
    // text is a provider refusal (an SDK-rejected call) earns the code, with
    // the raw text riding beside it. The vehicle is a stale resume ref whose
    // rejection message carries the refusal text.
    const t = createTestTransport();
    const run = runSupervisor(
      config(home("sup-refusal-")),
      createFakeHarness(),
      t.transport,
    );

    t.push(
      deliver("t1", "cv-a", { resumeSessionRef: "sess: rate limit reached" }),
    );
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("model_provider_error");
    expect(failed?.error).toContain("unknown session");
    // A refusal is one turn's problem, never a dead harness.
    expect(t.of("unhealthy")).toHaveLength(0);
  });

  it("a DEATH whose last words look like a refusal still classifies as the death", async () => {
    // Precedence: the death codes carry lifecycle semantics (revival,
    // visibility) the provider code must never usurp — a dying harness that
    // happens to mention a rate limit is still a dead harness.
    const t = createTestTransport();
    const harness = createFakeHarness({ script: longScript });
    const run = runSupervisor(
      config(home("sup-refusal-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => deltasOf(t, "t1").length >= 3, "the turn to start");
    harness.simulateFailure("connection closed: rate limit reached");
    await run;

    const failed = t.of("turn.result").find((r) => r.turnId === "t1");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("agent_restarted");
  });
});

/** Wrap a harness so its sessions count `abort()` calls — the defensive
 * abort has no other observable on the fake (its `aborted` flag resets per
 * turn). Delegation, not spread: session methods live on the prototype. */
const withAbortCounter = (base: Harness) => {
  const counter = { aborts: 0 };
  const startSession = base.startSession.bind(base);
  const harness: Harness = {
    ...base,
    startSession: async (options) => {
      const session = await startSession(options);
      return {
        sessionRef: session.sessionRef,
        runTurn: (input) => session.runTurn(input),
        ...(session.steer && {
          steer: session.steer.bind(session),
        }),
        abort: async () => {
          counter.aborts += 1;
          await session.abort();
        },
      };
    },
  };
  return { harness, counter };
};

describe("a busy harness on a live session", () => {
  const BUSY = "Already processing a message";

  it("a harness_busy terminal earns the code, with the raw refusal beside it", async () => {
    // The adapter mints the code when its self-heal exhausts; the supervisor
    // must carry it — and attach the raw text as the version-skew guard (an
    // old control plane ignores the code, and a NULL error there is the
    // silent-failure shape this whole fix exists to kill).
    const t = createTestTransport();
    const harness = createFakeHarness({
      script: () => [{ type: "error", message: BUSY, code: "harness_busy" }],
    });
    const run = runSupervisor(config(home("sup-busy-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("harness_busy");
    expect(failed?.error).toBe(BUSY);
    // Busy is one turn's problem, never a dead harness.
    expect(t.of("unhealthy")).toHaveLength(0);
  });

  it("the busy VOCABULARY alone never mints the code — only the adapter's event code does", async () => {
    // Invariant 9: the vendor's wording is the adapter's to interpret. A
    // terminal that merely quotes it (uncoded) stays the raw passthrough.
    const t = createTestTransport();
    const harness = createFakeHarness({
      script: () => [{ type: "error", message: BUSY }],
    });
    const run = runSupervisor(config(home("sup-busy-")), harness, t.transport);

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBeUndefined();
  });
});

describe("the defensive abort", () => {
  it("cancels the harness run when a turn fails without a clean end", async () => {
    // The orphan-burn fix: a turn reported failed while the harness may
    // still be executing its run must not leave that run alive (23 minutes,
    // live). The session's abort is the cancel.
    const t = createTestTransport();
    const { harness, counter } = withAbortCounter(
      createFakeHarness({
        script: () => [{ type: "error", message: "stream fell over" }],
      }),
    );
    const run = runSupervisor(
      config(home("sup-dabort-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    expect(counter.aborts).toBe(1);
    // Cleanup, never a reclassification: the failure stays a failure.
    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
  });

  it("never fires for a clean turn", async () => {
    const t = createTestTransport();
    const { harness, counter } = withAbortCounter(createFakeHarness());
    const run = runSupervisor(
      config(home("sup-dabort-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the clean turn");
    await t.finish(run);

    expect(counter.aborts).toBe(0);
  });

  it("never doubles a user abort", async () => {
    const t = createTestTransport();
    const { harness, counter } = withAbortCounter(
      createFakeHarness({ script: longScript }),
    );
    const run = runSupervisor(
      config(home("sup-dabort-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => deltasOf(t, "t1").length >= 3,
      "the turn to be mid-stream",
    );
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });
    await t.until(() => t.of("turn.result").length === 1, "the aborted turn");
    await t.finish(run);

    const [result] = t.of("turn.result");
    expect(result?.status).toBe("aborted");
    // Exactly the user's abort — the defensive arm must not fire again.
    expect(counter.aborts).toBe(1);
  });

  it("never fires against a dead harness", async () => {
    const t = createTestTransport();
    const { harness, counter } = withAbortCounter(
      createFakeHarness({ script: longScript }),
    );
    const fake = harness as Harness & { simulateFailure: (r?: string) => void };
    const run = runSupervisor(
      config(home("sup-dabort-")),
      harness,
      t.transport,
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => deltasOf(t, "t1").length >= 3,
      "the turn to be mid-stream",
    );
    fake.simulateFailure("harness connection closed");
    await run;

    const [failed] = t.of("turn.result");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("agent_restarted");
    // Nothing to cancel on a dead harness.
    expect(counter.aborts).toBe(0);
  });
});

/** A ProcessManager stub that records safety-net calls — the net's timing
 * and gating live in the supervisor; the arming itself is manager-tested. */
const netStub = () => {
  const netCalls: { conversationId: string; turnId?: string }[] = [];
  const manager: ProcessManager = {
    start: () => ({ ok: true }),
    status: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    watch: () => ({ ok: true }),
    observeUpsert: () => ({ created: false, hasArmedWatch: false }),
    cancelWatch: () => false,
    armTurnEndSafetyNet: (context) => {
      netCalls.push(context);
      return 1;
    },
    close: () => undefined,
    killAllSync: () => undefined,
  };
  return { manager, netCalls };
};

describe("the turn-end safety net (supervisor gating)", () => {
  it("arms after a DONE turn, with the ending turn's context as fallback", async () => {
    const t = createTestTransport();
    const { manager, netCalls } = netStub();
    const run = runSupervisor(
      config(home("sup-net-")),
      createFakeHarness(),
      t.transport,
      { processManager: manager },
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the turn");
    await t.finish(run);

    expect(netCalls).toEqual([{ conversationId: "cv-a", turnId: "t1" }]);
  });

  it("arms after a FAILED turn — leftover work still deserves its report", async () => {
    const t = createTestTransport();
    const { manager, netCalls } = netStub();
    const run = runSupervisor(
      config(home("sup-net-")),
      createFakeHarness({
        script: () => [{ type: "error", message: "stream fell over" }],
      }),
      t.transport,
      { processManager: manager },
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(() => t.of("turn.result").length === 1, "the failed turn");
    await t.finish(run);

    expect(netCalls).toHaveLength(1);
  });

  it("never arms after a user abort — stop means silence", async () => {
    const t = createTestTransport();
    const { manager, netCalls } = netStub();
    const run = runSupervisor(
      config(home("sup-net-")),
      createFakeHarness({ script: longScript }),
      t.transport,
      { processManager: manager },
    );

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => deltasOf(t, "t1").length >= 3,
      "the turn to be mid-stream",
    );
    t.push({ kind: "turn.abort", turnId: "t1", conversationId: "cv-a" });
    await t.until(() => t.of("turn.result").length === 1, "the aborted turn");
    await t.finish(run);

    expect(t.of("turn.result")[0]?.status).toBe("aborted");
    expect(netCalls).toHaveLength(0);
  });

  it("never arms against a dead harness — the container is going down", async () => {
    const t = createTestTransport();
    const { manager, netCalls } = netStub();
    const harness = createFakeHarness({ script: longScript });
    const run = runSupervisor(config(home("sup-net-")), harness, t.transport, {
      processManager: manager,
    });

    t.push(deliver("t1", "cv-a"));
    await t.until(
      () => deltasOf(t, "t1").length >= 3,
      "the turn to be mid-stream",
    );
    harness.simulateFailure("harness connection closed");
    await run;

    expect(t.of("turn.result")[0]?.status).toBe("failed");
    expect(netCalls).toHaveLength(0);
  });
});
