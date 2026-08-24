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
  harness: "fake",
  runnerWsUrl: undefined,
  bootstrapToken: undefined,
});

const home = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const createTestTransport = () => {
  const sent: SupervisorMessage[] = [];
  const queue: WorkItem[] = [];
  let notify: (() => void) | undefined;

  const api = {
    sent,
    push(item: WorkItem) {
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
): WorkItem => ({ kind: "turn.deliver", turnId, conversationId, message });

const steer = (
  turnId: string,
  targetTurnId: string,
  conversationId: string,
  message = "also do this",
): WorkItem => ({
  kind: "turn.message",
  turnId,
  targetTurnId,
  conversationId,
  message,
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
    // The fake injects the steered text into the same run — the message
    // visibly joined THIS turn, not a later one.
    const injected = t
      .of("event")
      .some(
        (m) =>
          m.turnId === "t1" &&
          m.event.type === "text.delta" &&
          m.event.text.includes("fold this in"),
      );
    expect(injected).toBe(true);
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
});
