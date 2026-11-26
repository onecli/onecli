import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The model fallback's contract: whatever the model says, the dialog only
 * ever gets a schedule that actually fires, or "not understood". The model
 * call and key resolution are mocked at their seams (fast-model and
 * llm-direct-call have their own tests); the croner check is real.
 */

const seams = vi.hoisted(() => ({
  reply: vi.fn<() => Promise<string>>(),
  key: vi.fn<() => Promise<unknown>>(),
  agent: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("./judges/fast-model", () => ({ askFastModel: seams.reply }));
vi.mock("./llm-direct-call", () => ({ resolveLlmCallKey: seams.key }));
vi.mock("@onecli/db", () => ({
  db: { agent: { findFirst: seams.agent } },
}));

const { parseScheduleWords } = await import("./schedule-parse-service");

const parse = (text: string) =>
  parseScheduleWords("ws1", "org1", "ag1", { text, timezone: "UTC" });

beforeEach(() => {
  vi.clearAllMocks();
  seams.agent.mockResolvedValue({ id: "ag1", workspaceId: "ws1" });
  seams.key.mockResolvedValue({ ok: true, key: { provider: "anthropic" } });
});

describe("parseScheduleWords", () => {
  it("returns the model's schedule when it fires", async () => {
    seams.reply.mockResolvedValue('{"schedule": "0 9 1 * *"}');
    expect(await parse("the first of every month")).toEqual({
      ok: true,
      schedule: "0 9 1 * *",
    });
  });

  it("reads JSON wrapped in a code fence", async () => {
    seams.reply.mockResolvedValue('```json\n{"schedule": "*/15 * * * *"}\n```');
    expect(await parse("four times an hour")).toEqual({
      ok: true,
      schedule: "*/15 * * * *",
    });
  });

  it.each([
    ["null", '{"schedule": null}'],
    ["not a schedule", '{"schedule": "whenever"}'],
    ["a time already past", '{"schedule": "2020-01-01T09:00:00"}'],
    ["prose", "I think every Monday"],
    // croner would read these, firing every second; no save door accepts them.
    ["a seconds field", '{"schedule": "*/5 * * * * *"}'],
    ["a years field", '{"schedule": "0 0 9 * * * 2027"}'],
  ])("never passes on %s", async (_, reply) => {
    seams.reply.mockResolvedValue(reply);
    expect(await parse("something")).toEqual({
      ok: false,
      reason: "not-understood",
    });
  });

  it("a failed model call reads as not understood", async () => {
    seams.reply.mockRejectedValue(new Error("timeout"));
    expect(await parse("something")).toMatchObject({ ok: false });
  });

  it("says when the agent has no model key", async () => {
    seams.key.mockResolvedValue({ ok: false, reason: "missing" });
    expect(await parse("something")).toEqual({
      ok: false,
      reason: "no-model-key",
    });
    expect(seams.reply).not.toHaveBeenCalled();
  });
});
