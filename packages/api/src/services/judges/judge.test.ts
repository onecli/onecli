import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The classifier and the judge wrapper: the contract every LLM judge stands
 * on. The model is mocked at `fast-model`'s seam (its wire shapes are
 * fast-model.test.ts's); what is proven here is the shared behavior:
 * strict choice parsing, provider routing with fallback, the deadline, the
 * fallback, and that a verdict is logged without message content.
 */

const m = vi.hoisted(() => ({
  ask: vi.fn<
    (
      key: unknown,
      arg: { prompt: string; maxTokens: number; signal: AbortSignal },
    ) => Promise<string>
  >(),
  decide: vi.fn<
    (
      key: unknown,
      arg: {
        input: string;
        questions: { name: string }[];
        signal: AbortSignal;
      },
    ) => Promise<Map<string, { choice: string; confidence: number }>>
  >(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./fast-model", () => ({
  askFastModel: m.ask,
  askDecisions: m.decide,
}));
vi.mock("../../lib/logger", () => ({
  logger: { child: () => ({ info: m.info, debug: m.debug }) },
}));

const { classify, parseAnswers, renderPrompt } = await import("./classify");
const { defineJudge } = await import("./judge");

const ANTHROPIC = {
  provider: "anthropic",
  authMode: "api-key",
  value: "sk-ant-test",
} as const;
const OPENAI = { provider: "openai", value: "sk-test" } as const;

const COLOR = {
  name: "color",
  instructions: "Which color?",
  choices: [
    { value: "red", description: "warm" },
    { value: "blue", description: "cool" },
  ],
} as const;
const SIZE = {
  name: "size",
  instructions: "How big?",
  choices: [
    { value: "small", description: "tiny" },
    { value: "large", description: "huge" },
  ],
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("parseAnswers", () => {
  it("reads each labeled line, case- and markup-insensitive", () => {
    expect(parseAnswers([COLOR, SIZE], "COLOR: Red\n**size**: LARGE.")).toEqual(
      { color: "red", size: "large" },
    );
  });

  it("only declared choices count; anything else is absent, never guessed", () => {
    expect(parseAnswers([COLOR, SIZE], "COLOR: green\nSIZE: medium")).toEqual(
      {},
    );
  });

  it("the LAST labeled line wins, so reasoning that names a choice never counts", () => {
    expect(
      parseAnswers(
        [COLOR],
        "COLOR: red would be wrong here, the sky is cool.\nCOLOR: blue",
      ),
    ).toEqual({ color: "blue" });
  });

  it("a one-question judge accepts a final line that is only the choice", () => {
    expect(parseAnswers([COLOR], "The sky is cool.\nBLUE")).toEqual({
      color: "blue",
    });
  });

  it("never reads a choice buried in a sentence", () => {
    expect(parseAnswers([COLOR], "I think BLUE")).toEqual({});
    expect(parseAnswers([COLOR, SIZE], "blue\nlarge")).toEqual({});
  });
});

describe("renderPrompt", () => {
  it("lists every choice with what it means, and the exact answer block", () => {
    const prompt = renderPrompt({
      context: "CONTEXT",
      questions: [COLOR, SIZE],
    });
    expect(prompt.startsWith("CONTEXT")).toBe(true);
    expect(prompt).toContain("COLOR: Which color?\n- RED: warm\n- BLUE: cool");
    expect(prompt).toContain("COLOR: <RED | BLUE>\nSIZE: <SMALL | LARGE>");
    expect(prompt).not.toContain("reasoning");
  });

  it("asks for one line of reasoning first only when the judge wants it", () => {
    expect(
      renderPrompt({ context: "C", questions: [COLOR], reason: true }),
    ).toContain("First write ONE short line of reasoning");
  });
});

describe("classify", () => {
  const signal = () => new AbortController().signal;

  it("an Anthropic key asks the prompt path, with room for reasoning when asked", async () => {
    m.ask.mockResolvedValue("cool sky\nCOLOR: blue");
    const out = await classify({
      key: ANTHROPIC,
      context: "sky",
      questions: [COLOR],
      reason: true,
      signal: signal(),
    });
    expect(out).toEqual({ answers: { color: "blue" }, via: "prompt" });
    expect(m.decide).not.toHaveBeenCalled();
    expect(m.ask.mock.calls[0]![1].maxTokens).toBeGreaterThanOrEqual(100);
  });

  it("an OpenAI key asks Decisions first, mapped to declared choices only", async () => {
    m.decide.mockResolvedValue(
      new Map([
        ["color", { choice: "BLUE", confidence: 0.9 }],
        ["size", { choice: "huge", confidence: 0.9 }],
      ]),
    );
    const out = await classify({
      key: OPENAI,
      context: "sky",
      questions: [COLOR, SIZE],
      required: ["color"],
      signal: signal(),
    });
    // `huge` is a description, not a value: absent, never coerced.
    expect(out).toEqual({ answers: { color: "blue" }, via: "decisions" });
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("falls back to the prompt path when Decisions fails or skips a required question", async () => {
    // MUTATION-PROOF: drop the fallback and every OpenAI-keyed judge goes
    // dark whenever the beta endpoint refuses.
    m.decide.mockRejectedValueOnce(new Error("503"));
    m.ask.mockResolvedValue("COLOR: red");
    expect(
      (
        await classify({
          key: OPENAI,
          context: "c",
          questions: [COLOR],
          signal: signal(),
        })
      ).via,
    ).toBe("prompt");
    m.decide.mockResolvedValueOnce(
      new Map([["size", { choice: "small", confidence: 1 }]]),
    );
    expect(
      (
        await classify({
          key: OPENAI,
          context: "c",
          questions: [COLOR, SIZE],
          required: ["color"],
          signal: signal(),
        })
      ).answers,
    ).toEqual({ color: "red" });
  });

  it("gives Decisions its own budget, still bound to the caller's deadline", async () => {
    m.decide.mockResolvedValue(
      new Map([["color", { choice: "red", confidence: 1 }]]),
    );
    const caller = new AbortController();
    await classify({
      key: OPENAI,
      context: "c",
      questions: [COLOR],
      decisionsBudgetMs: 1_000,
      signal: caller.signal,
    });
    const sent = m.decide.mock.calls[0]![1].signal;
    expect(sent).not.toBe(caller.signal);
    expect(sent.aborted).toBe(false);
    caller.abort();
    expect(sent.aborted).toBe(true);
  });

  it("throws when nothing readable came back (the judge's fallback applies)", async () => {
    m.ask.mockResolvedValue("I cannot help with that.");
    await expect(
      classify({
        key: ANTHROPIC,
        context: "c",
        questions: [COLOR],
        signal: signal(),
      }),
    ).rejects.toThrow("no readable answer");
  });
});

describe("defineJudge", () => {
  const judge = defineJudge<{ text: string }, "warm" | "cool" | "unknown">({
    name: "test",
    deadlineMs: 500,
    fallback: "unknown",
    decide: async (_input, ask) => {
      const { color } = await ask({ context: "c", questions: [COLOR] });
      return color === "red" ? "warm" : color === "blue" ? "cool" : "unknown";
    },
    describe: (v) => v,
    logFields: () => ({ agentId: "ag-1" }),
  });

  it("returns the decided verdict and logs it without the message text", async () => {
    m.ask.mockResolvedValue("COLOR: red");
    expect(await judge({ key: ANTHROPIC, text: "secret words" })).toBe("warm");
    const [fields] = m.info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      judge: "test",
      verdict: "warm",
      outcome: "answered",
      via: "prompt",
      agentId: "ag-1",
    });
    expect(JSON.stringify(fields)).not.toContain("secret words");
  });

  it("any failure is the fallback, never a throw", async () => {
    m.ask.mockRejectedValue(new Error("refusal"));
    expect(await judge({ key: ANTHROPIC, text: "x" })).toBe("unknown");
    expect(m.info.mock.calls[0]![0]).toMatchObject({ outcome: "fallback" });
  });

  it("the deadline resolves the judge with the fallback even if the model never answers, and cancels the call", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    m.ask.mockImplementation(
      (_key, arg) =>
        new Promise(() => {
          seen = arg.signal;
        }),
    );
    const pending = judge({ key: ANTHROPIC, text: "x" });
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toBe("unknown");
    expect(m.info.mock.calls[0]![0]).toMatchObject({ outcome: "deadline" });
    expect(seen?.aborted).toBe(true);
  });

  it("the caller's own cancellation reaches the model call", async () => {
    let seen: AbortSignal | undefined;
    m.ask.mockImplementation(async (_key, arg) => {
      seen = arg.signal;
      return "COLOR: blue";
    });
    const caller = new AbortController();
    await judge({ key: ANTHROPIC, text: "x", signal: caller.signal });
    caller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("a quiet judge logs at debug", async () => {
    const quiet = defineJudge<object, string>({
      name: "quiet",
      deadlineMs: 500,
      fallback: "f",
      quiet: true,
      decide: async () => "v",
    });
    await quiet({ key: ANTHROPIC });
    expect(m.debug).toHaveBeenCalled();
    expect(m.info).not.toHaveBeenCalled();
  });
});
