import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentEvent, Harness } from "@onecli/agent-protocol";
import { parseFakeDirective } from "./fake-directives";
import { createFakeHarness } from "./fake";
import { startPlatformTools, type PlatformTools } from "../platform-tools";

/**
 * The step-13 fake seams: the `@fake:v1` directive (black-box turn scripting)
 * and the durable session store (resume across container recreation). The
 * conformance suite pins the default script path; these pin the seams.
 */

const directiveMessage = (steps: unknown[]): string =>
  `@fake:v1 ${JSON.stringify({ steps })}`;

const collect = async (
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const texts = (events: AgentEvent[]): string[] =>
  events.flatMap((event) => (event.type === "text.delta" ? [event.text] : []));

describe("parseFakeDirective", () => {
  it("returns null for an ordinary message", () => {
    expect(parseFakeDirective("hello there")).toBeNull();
    expect(parseFakeDirective("")).toBeNull();
  });

  it("parses a directive on the first line", () => {
    const parsed = parseFakeDirective(
      directiveMessage([{ op: "text", text: "hi" }]),
    );
    expect(parsed).toEqual({
      directive: { steps: [{ op: "text", text: "hi" }] },
    });
  });

  it("finds the directive after a prepended context frame", () => {
    // The supervisor prepends the delivery-only context to the model-facing
    // prompt, so the caller's line is NOT guaranteed to be line one.
    const message = `[Context: memory index]\n\n${directiveMessage([
      { op: "state" },
    ])}\ntrailing prose`;
    const parsed = parseFakeDirective(message);
    expect(parsed).toEqual({ directive: { steps: [{ op: "state" }] } });
  });

  it("reports invalid JSON instead of ignoring it", () => {
    const parsed = parseFakeDirective("@fake:v1 {nope");
    expect(parsed).toMatchObject({ error: expect.stringContaining("JSON") });
  });

  it("reports a shape mismatch and unknown ops", () => {
    expect(parseFakeDirective('@fake:v1 {"nope":1}')).toMatchObject({
      error: expect.stringContaining("steps"),
    });
    expect(
      parseFakeDirective(directiveMessage([{ op: "launch_missiles" }])),
    ).toMatchObject({ error: expect.stringContaining("unknown op") });
  });

  it("caps the step count", () => {
    const steps = Array.from({ length: 65 }, () => ({
      op: "text",
      text: "x",
    }));
    expect(parseFakeDirective(directiveMessage(steps))).toMatchObject({
      error: expect.stringContaining("too many steps"),
    });
  });

  it("clamps sleep to the ceiling", () => {
    const parsed = parseFakeDirective(
      directiveMessage([{ op: "sleep", ms: 999_999 }]),
    );
    expect(parsed).toEqual({
      directive: { steps: [{ op: "sleep", ms: 30_000 }] },
    });
  });
});

describe("directive turns", () => {
  const startTurn = async (harness: Harness, message: string) => {
    const session = await harness.startSession({ homeDir: "" });
    return { session, events: session.runTurn({ message }) };
  };

  it("runs text and state steps in order, echoing session facts", async () => {
    const harness = createFakeHarness();
    const { events } = await startTurn(
      harness,
      directiveMessage([{ op: "text", text: "first" }, { op: "state" }]),
    );
    const all = await collect(events);
    expect(all[0]).toEqual({ type: "turn.started" });
    expect(all.at(-1)).toEqual({ type: "turn.done" });
    const deltas = texts(all);
    expect(deltas[0]).toBe("first");
    expect(deltas[1]).toMatch(
      /^\[state sessionRef=fake-session-.* turnsRun=1\]$/,
    );
  });

  it("surfaces a malformed directive as readable text, never a hang", async () => {
    const harness = createFakeHarness();
    const { events } = await startTurn(harness, "@fake:v1 {broken");
    const all = await collect(events);
    expect(texts(all)[0]).toContain("[fake: bad directive:");
    expect(all.at(-1)).toEqual({ type: "turn.done" });
  });

  it("a scripted error is the terminal event", async () => {
    const harness = createFakeHarness();
    const { events } = await startTurn(
      harness,
      directiveMessage([
        { op: "text", text: "before" },
        { op: "error", message: "boom" },
        { op: "text", text: "unreachable" },
      ]),
    );
    const all = await collect(events);
    expect(all.at(-1)).toEqual({ type: "error", message: "boom" });
    expect(texts(all)).toEqual(["before"]);
  });

  it("injects a steer during a sleep step's runway", async () => {
    const harness = createFakeHarness();
    const session = await harness.startSession({ homeDir: "" });
    const iterator = session
      .runTurn({
        message: directiveMessage([
          { op: "sleep", ms: 300 },
          { op: "text", text: "after" },
        ]),
      })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: "turn.started" });
    await session.steer?.({ id: "steer-1", message: "mid-flight" });

    const rest: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    const deltas = texts(rest);
    expect(deltas.indexOf("\n[steered: mid-flight]")).toBeLessThan(
      deltas.indexOf("after"),
    );
    expect(rest).toContainEqual({
      type: "message.joined",
      followUpId: "steer-1",
    });
  });

  it("performs an http step and echoes status + body excerpt", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("hello from upstream");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const harness = createFakeHarness();
      const { events } = await startTurn(
        harness,
        directiveMessage([
          { op: "http", url: `http://127.0.0.1:${port}/probe` },
        ]),
      );
      const all = await collect(events);
      expect(texts(all)[0]).toBe("[http 200] hello from upstream");
    } finally {
      server.close();
    }
  });

  it("echoes an http failure as text instead of failing the turn", async () => {
    const harness = createFakeHarness();
    const { events } = await startTurn(
      harness,
      directiveMessage([
        // A closed port: connection refused, fast.
        { op: "http", url: "http://127.0.0.1:1/", timeoutMs: 2000 },
      ]),
    );
    const all = await collect(events);
    expect(texts(all)[0]).toMatch(/^\[http error\] /);
    expect(all.at(-1)).toEqual({ type: "turn.done" });
  });

  it("arms a launch failure via failNextStart", async () => {
    const harness = createFakeHarness();
    let failure: string | undefined;
    harness.onFailure((reason) => {
      failure = reason;
    });
    const { events } = await startTurn(
      harness,
      directiveMessage([{ op: "failNextStart", reason: "scripted death" }]),
    );
    const all = await collect(events);
    expect(texts(all)[0]).toBe("[fake: armed failNextStart]");
    await expect(harness.startSession({ homeDir: "" })).rejects.toThrow(
      "scripted death",
    );
    expect(failure).toBe("scripted death");
  });
});

describe("platform-tool step", () => {
  const socketPath = join(
    mkdtempSync(join(tmpdir(), "fake-dir-")),
    "tools.sock",
  );
  let tools: PlatformTools | undefined;

  afterAll(async () => {
    await tools?.close();
  });

  it("dials the platform-tools socket and echoes the result", async () => {
    tools = await startPlatformTools({
      socketPath,
      tools: [
        {
          name: "echo_tool",
          description: "echoes",
          inputSchema: {},
          execute: (args) => Promise.resolve({ ok: true, result: { args } }),
        },
      ],
      send: () => {},
      activeTurn: () => null,
    });

    const harness = createFakeHarness({ toolsSocketPath: () => socketPath });
    const session = await harness.startSession({ homeDir: "" });
    const all = await collect(
      session.runTurn({
        message: directiveMessage([
          { op: "tool", name: "echo_tool", args: { a: 1 } },
          { op: "tool", name: "missing_tool" },
        ]),
      }),
    );
    const deltas = texts(all);
    expect(deltas[0]).toBe('[tool echo_tool ok] {"args":{"a":1}}');
    expect(deltas[1]).toContain("[tool missing_tool error]");
  });
});

describe("durable session store", () => {
  it("resumes a session across harness recreation via the home file", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "fake-home-"));

    const first = createFakeHarness();
    const sessionA = await first.startSession({ homeDir });
    await collect(sessionA.runTurn({ message: "turn one" }));
    const ref = sessionA.sessionRef;
    if (!ref) throw new Error("fake session should always carry a ref");

    // A fresh harness with a fresh in-memory store = a recreated container.
    const second = createFakeHarness();
    const sessionB = await second.startSession({
      homeDir,
      resumeSessionRef: ref,
    });
    const all = await collect(
      sessionB.runTurn({ message: directiveMessage([{ op: "state" }]) }),
    );
    // turnsRun continues from the durable file: 1 persisted + this turn.
    expect(texts(all)[0]).toBe(`[state sessionRef=${ref} turnsRun=2]`);
  });

  it("without a durable home, an unknown resume ref still rejects", async () => {
    const harness = createFakeHarness();
    await expect(
      harness.startSession({ homeDir: "", resumeSessionRef: "fake-session-x" }),
    ).rejects.toThrow("unknown session");
  });

  it("tolerates a corrupt durable file by starting empty", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "fake-home-"));
    mkdirSync(join(homeDir, ".onecli"));
    writeFileSync(join(homeDir, ".onecli", "fake-sessions.json"), "{nope");

    const harness = createFakeHarness();
    const session = await harness.startSession({ homeDir });
    const all = await collect(session.runTurn({ message: "hello" }));
    expect(all.at(-1)).toEqual({
      type: "turn.done",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await expect(
      harness.startSession({ homeDir, resumeSessionRef: "fake-session-gone" }),
    ).rejects.toThrow("unknown session");
  });

  it("mints distinct fresh refs across recreations sharing one home", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "fake-home-"));
    const sessionA = await createFakeHarness().startSession({ homeDir });
    await collect(sessionA.runTurn({ message: "one" }));
    const sessionB = await createFakeHarness().startSession({ homeDir });
    // Without the ref nonce, both would mint "fake-session-1" and the new
    // session would silently inherit the old session's durable state.
    expect(sessionB.sessionRef).not.toBe(sessionA.sessionRef);
  });
});
