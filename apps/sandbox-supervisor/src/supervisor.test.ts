import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  supervisorMessageSchema,
  type SupervisorMessage,
} from "@onecli/agent-protocol";
import { createFakeHarness, type FakeScript } from "./harness/fake";
import { createStdioTransport } from "./transport/stdio";
import { runSupervisor } from "./supervisor";

describe("supervisor loop end-to-end (fake harness, stdio transport)", () => {
  it("renders the home, serves a turn, and reports the result", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: "You are the smoke-test agent.",
        agentName: "Ada",
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      createFakeHarness(),
      createStdioTransport(input, output),
    );

    input.write(
      '{"kind":"turn.deliver","turnId":"t1","conversationId":"cv1","message":"hello"}\n',
    );
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));

    expect(messages[0]).toEqual({ kind: "ready", harness: "fake" });
    const eventTypes = messages
      .filter((m) => m.kind === "event")
      .map((m) => (m.kind === "event" ? m.event.type : ""));
    expect(eventTypes[0]).toBe("turn.started");
    expect(eventTypes).toContain("text.delta");
    expect(eventTypes.at(-1)).toBe("turn.done");
    expect(messages.at(-1)).toMatchObject({
      kind: "turn.result",
      turnId: "t1",
      conversationId: "cv1",
      status: "done",
    });

    // The boot rendered the home: brief present, files locked.
    expect(statSync(join(homeDir, "CLAUDE.md")).mode & 0o777).toBe(0o444);
    expect(statSync(join(homeDir, "AGENTS.md")).mode & 0o777).toBe(0o444);

    // Gateway-first reaches the instruction doc end-to-end: the connections
    // fragment carries the gateway skill's exact path (the harness's own
    // skills index has none), and the skills fragment the read-to-load
    // mechanic.
    const doc = readFileSync(join(homeDir, "AGENTS.md"), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(doc).toContain("read .agents/skills/onecli-gateway/SKILL.md");
    expect(doc).toContain("read .agents/skills/<name>/SKILL.md yourself");

    // The machine fragment reaches the instruction doc end-to-end: the
    // persistence contract (durable ~, stopped-not-destroyed containers)
    // is registered unconditionally beside the other platform fragments.
    expect(doc).toContain("/workspace/.home");
    expect(doc).toContain("/etc/containers/README.onecli");
  });

  it("prepends delivery-only context to the harness prompt — and only when present", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      // The fake's default script echoes the prompt it was handed, so the
      // deltas ARE the proof of what reached the harness.
      createFakeHarness(),
      createStdioTransport(input, output),
    );

    input.write(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t1",
        conversationId: "cv1",
        message: "what is our staging url?",
        context:
          "[Your memory — index]\n- staging-url: where staging lives\n[End of memory]",
      }) + "\n",
    );
    input.write(
      JSON.stringify({
        kind: "turn.deliver",
        turnId: "t2",
        conversationId: "cv1",
        message: "thanks",
      }) + "\n",
    );
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
    const deltas = messages.flatMap((m) =>
      m.kind === "event" && m.event.type === "text.delta" ? [m.event.text] : [],
    );

    // Turn 1: context, a blank line, then the untouched human message.
    expect(deltas[0]).toBe(
      "Fake answer to: [Your memory — index]\n- staging-url: where staging lives\n[End of memory]\n\nwhat is our staging url?",
    );
    // Turn 2: no context, no stray separator — the message alone.
    expect(deltas[1]).toBe("Fake answer to: thanks");
  });
});

describe("home sync in the loop", () => {
  it("applies a two-part sync end to end and acks once", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      createFakeHarness(),
      createStdioTransport(input, output),
    );

    input.write(
      JSON.stringify({
        kind: "skills.changed",
        generation: 5,
        part: 1,
        of: 2,
        files: [
          { path: ".agents/skills/deploy/SKILL.md", content: "# deploy" },
        ],
      }) + "\n",
    );
    input.write(
      JSON.stringify({
        kind: "skills.changed",
        generation: 5,
        part: 2,
        of: 2,
        files: [{ path: "memory/index.md", content: "# Memory index" }],
        prune: [".agents/skills/deploy/SKILL.md", "memory/index.md"],
        instructions: "Synced brief.",
        agentName: "Ada",
      }) + "\n",
    );
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    expect(
      readFileSync(join(homeDir, ".agents/skills/deploy/SKILL.md"), "utf8"),
    ).toBe("# deploy");
    expect(readFileSync(join(homeDir, "memory/index.md"), "utf8")).toBe(
      "# Memory index",
    );
    expect(readFileSync(join(homeDir, "CLAUDE.md"), "utf8")).toContain(
      "Synced brief.",
    );

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
    const acks = messages.filter((m) => m.kind === "home.synced");
    expect(acks).toEqual([{ kind: "home.synced", generation: 5 }]);
  });

  it("a hung sync never blocks the reader — the abort still lands (and the ack flushes before close)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    let releaseSync: (() => void) | undefined;
    const syncStarted = new Promise<void>((resolveStarted) => {
      const hung = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      applySyncStub = async (_dir, item, _inputs, send) => {
        resolveStarted();
        await hung;
        send({ kind: "home.synced", generation: item.generation });
      };
      void hung;
    });

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      // A slow fake turn gives the abort something real to stop.
      createFakeHarness(),
      createStdioTransport(input, output),
      { applySync: (...args) => applySyncStub(...args) },
    );

    input.write(
      JSON.stringify({
        kind: "skills.changed",
        generation: 9,
        part: 1,
        of: 1,
        files: [],
        prune: [],
      }) + "\n",
    );
    await syncStarted;
    // With the sync HUNG, a turn + its abort must still round-trip.
    input.write(
      '{"kind":"turn.deliver","turnId":"t1","conversationId":"cv1","message":"hi"}\n',
    );
    input.write('{"kind":"turn.abort","turnId":"t1","conversationId":"cv1"}\n');
    // Give the loop a beat, then release the sync and shut down.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseSync?.();
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
    // The turn produced a terminal result while the sync was still hung —
    // the reader never awaited the sync chain.
    expect(messages.some((m) => m.kind === "turn.result")).toBe(true);
    // And the ack still flushed before close (the shutdown drain).
    expect(
      messages.some((m) => m.kind === "home.synced" && m.generation === 9),
    ).toBe(true);
  });

  it("a turn NEVER starts ahead of an in-flight sync apply — the boot seed lands first", async () => {
    // MUTATION-PROOF for the boot-race fix: drop runTurn's `await syncQueue`
    // and this fails — the fake harness's turn would start while the boot
    // sync's writes are still landing, and the agent's first memory/ read
    // would miss files the platform already holds.
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    const order: string[] = [];
    let releaseSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    applySyncStub = async (_dir, item, _inputs, send) => {
      order.push("sync-start");
      await syncGate;
      order.push("sync-end");
      send({ kind: "home.synced", generation: item.generation });
    };

    const harness = createFakeHarness();
    const wrapped: typeof harness = {
      ...harness,
      startSession: async (options) => {
        order.push("session-start");
        return harness.startSession(options);
      },
    };

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      wrapped,
      createStdioTransport(input, output),
      { applySync: (...args) => applySyncStub(...args) },
    );

    // The boot batch: sync first, turn right behind it — the wire order.
    input.write(
      JSON.stringify({
        kind: "skills.changed",
        generation: 1,
        part: 1,
        of: 1,
        files: [],
        prune: [],
      }) + "\n",
    );
    input.write(
      '{"kind":"turn.deliver","turnId":"t1","conversationId":"cv1","message":"first"}\n',
    );
    // Give the reader a beat with the sync still hung: the turn must NOT
    // have started a session yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["sync-start"]);
    releaseSync?.();
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    expect(order).toEqual(["sync-start", "sync-end", "session-start"]);
  });

  it("an abort that lands while a turn N≥2 is parked on the sync await is honored, not swallowed", async () => {
    // MUTATION-PROOF (lens-4 catch, a regression the boot-race await widened):
    // `abort()` must park into pendingAborts whenever the STREAM isn't live —
    // not only when the session is absent (true just for a conversation's
    // first turn). Key it on `session` instead of `streamStarted` and this
    // fails: for turn t2 the session survives from t1, so the abort fires
    // live against an idle session (no-op) and t2 runs to completion while
    // reporting "aborted". The window is the whole sync apply (here hung).
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    let releaseSync: (() => void) | undefined;
    let syncStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => (syncStarted = r));
    // Only `skills.changed` frames drive applySync (boot renders, never
    // syncs), so the single sync below IS the one that hangs — holding t2 on
    // `await syncQueue` after t1 has already established the session.
    applySyncStub = async (_dir, item, _inputs, send) => {
      syncStarted?.();
      await new Promise<void>((r) => (releaseSync = r));
      send({ kind: "home.synced", generation: item.generation });
    };

    let t2Streamed = false;
    // Resolves once t1's stream has been fully CONSUMED, so the test waits for
    // the session to genuinely exist rather than guessing how long that takes.
    // The fixed sleep this replaces was the whole flake: on a loaded runner t1
    // had not established the session yet, so t2 never parked on the sync and
    // ran normally — reporting "done" against an expected "aborted".
    //
    // Draining matters: `runTurn` is a generator, so CALLING it runs nothing.
    // Signalling at the call would fire before the session is established and
    // reintroduce the same race in a new disguise.
    let t1Done: (() => void) | undefined;
    const t1Finished = new Promise<void>((r) => (t1Done = r));
    const harness = createFakeHarness();
    const wrapped: typeof harness = {
      ...harness,
      startSession: async (options) => {
        const session = await harness.startSession(options);
        return {
          ...session,
          runTurn: (input) => {
            // The first stream is t1's; anything after it is t2 reaching the
            // harness, which is exactly what must never happen here.
            if (!t1Done) {
              t2Streamed = true;
              return session.runTurn(input);
            }
            const signal = t1Done;
            t1Done = undefined;
            const inner = session.runTurn(input);
            return (async function* () {
              try {
                yield* inner;
              } finally {
                signal();
              }
            })();
          },
        };
      },
    };

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      wrapped,
      createStdioTransport(input, output),
      { applySync: (...args) => applySyncStub(...args) },
    );

    // t1 establishes the per-conversation session.
    input.write(
      '{"kind":"turn.deliver","turnId":"t1","conversationId":"cv1","message":"one"}\n',
    );
    // Wait for the FACT (t1's stream finished ⇒ the session exists), never a
    // duration.
    await t1Finished;
    // A sync (hangs) then t2 right behind it, then the abort for t2.
    input.write(
      JSON.stringify({
        kind: "skills.changed",
        generation: 5,
        part: 1,
        of: 1,
        files: [],
        prune: [],
      }) + "\n",
    );
    input.write(
      '{"kind":"turn.deliver","turnId":"t2","conversationId":"cv1","message":"two"}\n',
    );
    input.write('{"kind":"turn.abort","turnId":"t2","conversationId":"cv1"}\n');
    await started; // t2 is now parked on the hung sync
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSync?.();
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
    const t2Result = messages.find(
      (m) => m.kind === "turn.result" && m.turnId === "t2",
    );
    expect(t2Result).toMatchObject({ status: "aborted" });
    // The load-bearing half: t2 was honored BEFORE streaming — it never ran.
    expect(t2Streamed).toBe(false);
  });

  it("a rejecting sync poisons nothing — the next sync still applies", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    let calls = 0;
    applySyncStub = async (_dir, item, _inputs, send) => {
      calls += 1;
      if (calls === 1) throw new Error("transient fs error");
      send({ kind: "home.synced", generation: item.generation });
    };

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      createFakeHarness(),
      createStdioTransport(input, output),
      { applySync: (...args) => applySyncStub(...args) },
    );

    const frame = (generation: number) =>
      JSON.stringify({
        kind: "skills.changed",
        generation,
        part: 1,
        of: 1,
        files: [],
        prune: [],
      }) + "\n";
    input.write(frame(1));
    input.write(frame(2));
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
    expect(messages.filter((m) => m.kind === "home.synced")).toEqual([
      { kind: "home.synced", generation: 2 },
    ]);
  });

  it("a failed part suppresses the ack for its WHOLE generation", async () => {
    // The hole this closes: the `.catch` recovers the chain, so without
    // per-generation poisoning the FINAL part would still prune and ack, and
    // the control plane would mark a half-written projection complete —
    // permanently, since nothing retries an applied generation.
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();

    const applied: number[] = [];
    applySyncStub = async (_dir, item, _inputs, send) => {
      if (item.generation === 5 && item.part === 1) {
        throw new Error("ENOSPC");
      }
      applied.push(item.part);
      if (item.part === item.of) {
        send({ kind: "home.synced", generation: item.generation });
      }
    };

    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      createFakeHarness(),
      createStdioTransport(input, output),
      { applySync: (...args) => applySyncStub(...args) },
    );

    const part = (generation: number, index: number, of: number) =>
      JSON.stringify({
        kind: "skills.changed",
        generation,
        part: index,
        of,
        files: [],
        ...(index === of && { prune: [] }),
      }) + "\n";
    // Generation 5: part 1 fails, so part 2 must never run or ack.
    input.write(part(5, 1, 2));
    input.write(part(5, 2, 2));
    // Generation 6 is a fresh generation and proceeds normally.
    input.write(part(6, 1, 1));
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    const messages: SupervisorMessage[] = (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
    expect(messages.filter((m) => m.kind === "home.synced")).toEqual([
      { kind: "home.synced", generation: 6 },
    ]);
    // Part 2 of the poisoned generation was skipped whole, not just un-acked.
    expect(applied).toEqual([1]);
  });
});

let applySyncStub: (
  ...args: Parameters<typeof import("./home/materializer").applyHomeSync>
) => Promise<void>;

describe("the harvester is wired into the sync apply", () => {
  it("a divergent memory file on disk is handed to the harvester during a sync", async () => {
    // MUTATION-PROOF (lens-5 catch): drop the `harvester` argument from the
    // `applySync(...)` call and this fails — the param defaults to null, the
    // materializer's overwrite gate then treats every divergent file as
    // "left un-harvested" and the write-back-on-collision half of the design
    // goes silently dark. Here a stub harvester records the consult.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { renderMemoryFile } = await import("@onecli/agent-protocol");
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    // Agent-authored bytes already on disk where the projection will land.
    mkdirSync(join(homeDir, "memory"), { recursive: true });
    writeFileSync(join(homeDir, "memory/fact.md"), "the agent's own edit");

    const harvested: string[] = [];
    const stubHarvester = {
      poll: async () => undefined,
      harvestFile: async (fileName: string) => {
        harvested.push(fileName);
        return "refused" as const; // spare the file (never destroyed)
      },
      forgetFile: () => undefined,
      handleResult: () => undefined,
      stop: () => undefined,
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      createFakeHarness(),
      createStdioTransport(input, output),
      { memoryHarvester: stubHarvester },
    );

    // A sync whose canonical projection collides with the agent's file.
    input.write(
      JSON.stringify({
        kind: "skills.changed",
        generation: 1,
        part: 1,
        of: 1,
        files: [
          {
            path: "memory/fact.md",
            content: renderMemoryFile({
              key: "fact",
              title: null,
              description: null,
              content: "the platform version",
            }),
          },
        ],
        prune: ["memory/fact.md"],
      }) + "\n",
    );
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;

    expect(harvested).toContain("fact.md");
    // Refused → the agent's bytes were spared, not clobbered.
    expect(readFileSync(join(homeDir, "memory/fact.md"), "utf8")).toBe(
      "the agent's own edit",
    );
  });
});

/**
 * THE ANSWER IS THE LAST MESSAGE (user decision, 2026-08-31).
 *
 * The live failure: agents answered chat with multi-screen walls that the
 * response-style prompt could not fix, because the model was already obeying
 * it — writing short messages between tool calls. The supervisor concatenated
 * every one of them into a single durable `text`, so the running commentary
 * was published AS the answer. These pins hold the boundary: narration
 * streams and vanishes, the closing message is the record.
 */
describe("the answer is the agent's last message, not its whole turn", () => {
  const runWithScript = async (
    script: FakeScript,
  ): Promise<SupervisorMessage[]> => {
    const homeDir = mkdtempSync(join(tmpdir(), "supervisor-"));
    const input = new PassThrough();
    const output = new PassThrough();
    const run = runSupervisor(
      {
        homeDir,
        model: undefined,
        effort: undefined,
        instructions: undefined,
        agentName: undefined,
        harness: "fake",
        runnerWsUrl: undefined,
        bootstrapToken: undefined,
      },
      createFakeHarness({ script }),
      createStdioTransport(input, output),
    );
    input.write(
      '{"kind":"turn.deliver","turnId":"t1","conversationId":"cv1","message":"go"}\n',
    );
    input.write('{"kind":"shutdown"}\n');
    input.end();
    await run;
    return (output.read()?.toString() ?? "")
      .trim()
      .split("\n")
      .map((line: string) => supervisorMessageSchema.parse(JSON.parse(line)));
  };

  /** The one durable answer this turn produced, or null if it stayed silent. */
  const answerOf = (messages: SupervisorMessage[]): string | null => {
    const texts = messages.flatMap((m) =>
      m.kind === "event" && m.event.type === "text" ? [m.event.text] : [],
    );
    expect(texts.length).toBeLessThanOrEqual(1);
    return texts[0] ?? null;
  };

  it("keeps only the closing message when narration precedes the tools", async () => {
    // The exact shape of the reported walls: three compliant one-liners, two
    // of them mid-work. MUTATION-PROOF: restore the `answer +=`
    // concatenation and the narration reappears in the stored answer.
    const messages = await runWithScript(() => [
      { type: "text.delta", text: "Let me check the logs." },
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
      { type: "text.delta", text: "Now the config." },
      { type: "tool.started", callId: "c2", name: "read" },
      { type: "tool.finished", callId: "c2", name: "read", output: "ok" },
      { type: "text.delta", text: "CI passed; nothing to do." },
      { type: "turn.done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    expect(answerOf(messages)).toBe("CI passed; nothing to do.");
    // The narration still STREAMED — it is progress, and the surfaces render
    // it live; it simply is not the record.
    const deltas = messages.flatMap((m) =>
      m.kind === "event" && m.event.type === "text.delta" ? [m.event.text] : [],
    );
    expect(deltas).toContain("Let me check the logs.");
    expect(deltas).toContain("Now the config.");
  });

  it("joins deltas within one message, so a streamed sentence stays whole", async () => {
    // Segmentation is per MESSAGE, not per delta: token-by-token streaming
    // inside one message must still concatenate.
    const messages = await runWithScript(() => [
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
      { type: "text.delta", text: "All " },
      { type: "text.delta", text: "four " },
      { type: "text.delta", text: "gates are green." },
      { type: "turn.done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    expect(answerOf(messages)).toBe("All four gates are green.");
  });

  it("falls back to the last thing said when a turn ends mid-tool", async () => {
    // Never silent: a turn that stopped while working still said something,
    // and posting nothing reads as the agent ignoring the person.
    const messages = await runWithScript(() => [
      { type: "text.delta", text: "Starting the deploy." },
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "error", message: "the harness died" },
    ]);

    expect(answerOf(messages)).toBe("Starting the deploy.");
  });

  it("does not let back-to-back tools erase the last words said", async () => {
    // An empty segment must never displace a real one — otherwise a trailing
    // pair of tool calls would blank the fallback and the turn goes silent.
    const messages = await runWithScript(() => [
      { type: "text.delta", text: "Found the cause." },
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
      { type: "tool.started", callId: "c2", name: "bash" },
      { type: "tool.finished", callId: "c2", name: "bash", output: "ok" },
      { type: "error", message: "stopped" },
    ]);

    expect(answerOf(messages)).toBe("Found the cause.");
  });

  it("stays silent when the agent never said anything", async () => {
    const messages = await runWithScript(() => [
      { type: "tool.started", callId: "c1", name: "bash" },
      { type: "tool.finished", callId: "c1", name: "bash", output: "ok" },
      { type: "turn.done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    expect(answerOf(messages)).toBeNull();
  });
});
