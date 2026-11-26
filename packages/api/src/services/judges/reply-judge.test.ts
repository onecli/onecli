import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The judge's contract: a clear verdict from the fast model - who the
 * message is for, and for the agent's ones, WHERE to answer (thread or
 * channel; the channel by default) - and `null` (let the agent decide) on
 * every other path, never a throw or a guessed verdict. The shared engine
 * (classify + defineJudge) is proven in judge.test.ts; the wire, in
 * fast-model.test.ts.
 */

const ask = vi.hoisted(() =>
  vi.fn<(key: unknown, arg: { prompt: string }) => Promise<string>>(),
);
const decide = vi.hoisted(() =>
  vi.fn<
    (
      key: unknown,
      arg: { questions: { name: string }[]; signal: AbortSignal },
    ) => Promise<Map<string, { choice: string; confidence: number }>>
  >(),
);
vi.mock("./fast-model", () => ({
  askFastModel: ask,
  askDecisions: decide,
}));

const { judgeReply } = await import("./reply-judge");

const ANTHROPIC_KEY = {
  provider: "anthropic",
  authMode: "api-key",
  value: "sk-ant-test",
} as const;
const OPENAI_KEY = { provider: "openai", value: "sk-test" } as const;

const INPUT = {
  key: ANTHROPIC_KEY,
  signal: new AbortController().signal,
  agent: { id: "ag1", name: "Rafi" },
  instructions: "Owns PR reviews and deploys.",
  transcript: ["person U1: hi all", "person U2: Dana, what time is it?"],
};

beforeEach(() => {
  ask.mockReset();
  decide.mockReset();
});

const promptOf = () =>
  (ask.mock.calls.at(-1) as unknown as [unknown, { prompt: string }])[1].prompt;

/** The prompt path's answer block: `WHO: x` and `WHERE: y` lines. */
const said = (who: string, where = "channel") => `WHO: ${who}\nWHERE: ${where}`;

describe("judgeReply", () => {
  it.each([
    [said("AGENT", "CHANNEL"), { reply: true, placement: "channel" }],
    [said("ROOM", "THREAD"), { reply: true, placement: "thread" }],
    ["who: Agent\n**where**: thread.", { reply: true, placement: "thread" }],
    // A reply with no readable placement goes to the channel (the default).
    ["WHO: AGENT", { reply: true, placement: "channel" }],
    [said("OTHER"), { reply: false }],
    [said("none"), { reply: false }],
  ])("reads %j", async (answer, verdict) => {
    ask.mockResolvedValue(answer);
    expect(await judgeReply(INPUT)).toEqual(verdict);
  });

  it("no verdict (null) on an unreadable answer or a failed call, never a throw", async () => {
    ask.mockResolvedValue("WHO: maybe");
    expect(await judgeReply(INPUT)).toBeNull();
    ask.mockRejectedValue(new Error("anthropic refusal"));
    expect(await judgeReply(INPUT)).toBeNull();
  });

  it("every model call is bound to the caller's deadline signal", async () => {
    ask.mockResolvedValue(said("NONE"));
    const deadline = new AbortController();
    await judgeReply({ ...INPUT, signal: deadline.signal });
    const sent = ask.mock.calls[0]![1] as unknown as { signal: AbortSignal };
    expect(sent.signal.aborted).toBe(false);
    deadline.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it("the prompt carries the name, the role, every choice, and the final message on its own", async () => {
    ask.mockResolvedValue(said("NONE"));
    await judgeReply(INPUT);
    const prompt = promptOf();
    expect(prompt).toContain('"Rafi"');
    expect(prompt).toContain("Owns PR reviews and deploys.");
    for (const label of [
      "- AGENT:",
      "- OTHER:",
      "- ROOM:",
      "- NONE:",
      "- CHANNEL:",
      "- THREAD:",
    ]) {
      expect(prompt).toContain(label);
    }
    expect(prompt).toContain(
      "Final message:\nperson U2: Dana, what time is it?",
    );
  });

  it("a person's request about WHERE to reply wins over the judge's own pick (and is only asked when the room talks about threads)", async () => {
    const thread = {
      ...INPUT,
      transcript: [
        "Dana: rafi please answer in a thread from now on",
        "Dana: rafi what time is it?",
      ],
    };
    // Two calls ride in parallel: who/where, then the request check.
    ask.mockImplementation(async (_key, arg) =>
      arg.prompt.includes("MOST RECENT")
        ? "REQUEST: THREADS"
        : said("AGENT", "CHANNEL"),
    );
    expect(await judgeReply(thread)).toEqual({
      reply: true,
      placement: "thread",
    });
    // No thread talk in the room: the request check never runs.
    ask.mockReset();
    ask.mockResolvedValue(said("AGENT", "CHANNEL"));
    await judgeReply(INPUT);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("an Anthropic key never asks the Decisions API", async () => {
    ask.mockResolvedValue(said("NONE"));
    await judgeReply(INPUT);
    expect(decide).not.toHaveBeenCalled();
  });

  describe("OpenAI Decisions path", () => {
    const answers = (who: string, where: string, request = "none") =>
      new Map([
        ["who", { choice: who, confidence: 0.95 }],
        ["where", { choice: where, confidence: 0.9 }],
        ["request", { choice: request, confidence: 0.9 }],
      ]);
    const OPENAI = { ...INPUT, key: OPENAI_KEY };

    it("asks who / where / request in ONE call and maps the typed answers; the prompt path never runs", async () => {
      decide.mockResolvedValue(answers("agent", "thread"));
      expect(await judgeReply(OPENAI)).toEqual({
        reply: true,
        placement: "thread",
      });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide.mock.calls[0]![1].questions.map((q) => q.name)).toEqual([
        "who",
        "where",
        "request",
      ]);
      expect(ask).not.toHaveBeenCalled();
    });

    it("other / none never reply; room replies", async () => {
      decide.mockResolvedValue(answers("other", "channel"));
      expect(await judgeReply(OPENAI)).toEqual({ reply: false });
      decide.mockResolvedValue(answers("none", "thread"));
      expect(await judgeReply(OPENAI)).toEqual({ reply: false });
      decide.mockResolvedValue(answers("room", "channel"));
      expect(await judgeReply(OPENAI)).toEqual({
        reply: true,
        placement: "channel",
      });
    });

    it("a person's request about where wins over the judge's own pick", async () => {
      decide.mockResolvedValue(answers("agent", "channel", "threads"));
      expect(await judgeReply(OPENAI)).toEqual({
        reply: true,
        placement: "thread",
      });
      decide.mockResolvedValue(answers("agent", "thread", "channel"));
      expect(await judgeReply(OPENAI)).toEqual({
        reply: true,
        placement: "channel",
      });
    });

    it("a failed Decisions call (beta endpoint down) falls back to the prompt path, never to silence", async () => {
      // MUTATION-PROOF: drop the catch and the judge goes dark for every
      // OpenAI-keyed agent whenever the beta endpoint refuses.
      decide.mockRejectedValue(new Error("openai decisions 503"));
      ask.mockResolvedValue(said("AGENT", "CHANNEL"));
      expect(await judgeReply(OPENAI)).toEqual({
        reply: true,
        placement: "channel",
      });
      expect(ask).toHaveBeenCalled();
    });

    it("a refused 'who' question is no Decisions verdict: the prompt path answers", async () => {
      decide.mockResolvedValue(new Map());
      ask.mockResolvedValue(said("OTHER"));
      expect(await judgeReply(OPENAI)).toEqual({ reply: false });
    });

    it("the Decisions call gets its own sub-budget, still bound to the caller's deadline", async () => {
      // MUTATION-PROOF: hand the call the bare caller signal and a slow
      // Decisions failure leaves the prompt path no time to answer.
      decide.mockResolvedValue(answers("none", "channel"));
      const deadline = new AbortController();
      await judgeReply({ ...OPENAI, signal: deadline.signal });
      const sent = decide.mock.calls[0]![1].signal;
      expect(sent).not.toBe(deadline.signal);
      expect(sent.aborted).toBe(false);
      deadline.abort();
      expect(sent.aborted).toBe(true);
    });

    it("a Decisions answer without 'who' (but with where) still takes the prompt path", async () => {
      // `who` is the one required answer: a partial set must not pass as a
      // verdict with an undefined addressee.
      decide.mockResolvedValue(
        new Map([["where", { choice: "thread", confidence: 0.9 }]]),
      );
      ask.mockResolvedValue(said("ROOM", "THREAD"));
      expect(await judgeReply(OPENAI)).toEqual({
        reply: true,
        placement: "thread",
      });
      expect(ask).toHaveBeenCalled();
    });
  });
});
