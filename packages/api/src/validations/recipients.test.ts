import { describe, expect, it } from "vitest";
import { parseThreadRef, sendMessageArgsSchema } from "./recipients";

describe("parseThreadRef", () => {
  it("a bare message id names no channel", () => {
    expect(parseThreadRef(" 1781870000.123579 ")).toEqual({
      ts: "1781870000.123579",
      channel: null,
    });
  });

  it("a message link carries its channel and its ts (the digits regain their dot)", () => {
    expect(
      parseThreadRef(
        "https://acme-example.slack.com/archives/c0abc123/p1781870000123579",
      ),
    ).toEqual({ ts: "1781870000.123579", channel: "C0ABC123" });
  });

  it("a reply's link names its thread's root through thread_ts", () => {
    expect(
      parseThreadRef(
        "https://acme-example.slack.com/archives/C0ABC123/p1781870000999999?thread_ts=1781870000.123579&cid=C0ABC123",
      ),
    ).toEqual({ ts: "1781870000.123579", channel: "C0ABC123" });
  });

  it("an Enterprise Grid link parses; a malformed thread_ts falls back to the link's own ts", () => {
    expect(
      parseThreadRef(
        "https://acme.enterprise.slack.com/archives/C0ABC123/p1781870000123579?thread_ts=nope",
      ),
    ).toEqual({ ts: "1781870000.123579", channel: "C0ABC123" });
  });

  it("anything else is not a thread", () => {
    for (const raw of [
      "",
      "thread",
      "1781870000",
      "https://example.com/archives/C0ABC123/p1781870000123579",
      "https://acme.slack.com.evil.example/archives/C0ABC123/p1781870000123579",
      "http://acme.slack.com/archives/C0ABC123/p1781870000123579",
    ]) {
      expect(parseThreadRef(raw)).toBeNull();
    }
  });
});

describe("sendMessageArgsSchema.thread", () => {
  const base = { to: "#team-updates", text: "hi" };

  it("parses to a thread ref at the door", () => {
    const parsed = sendMessageArgsSchema.parse({
      ...base,
      thread: "1781870000.123579",
    });
    expect(parsed.thread).toEqual({ ts: "1781870000.123579", channel: null });
  });

  it("refuses something that is not a thread, saying nothing was sent", () => {
    const parsed = sendMessageArgsSchema.safeParse({
      ...base,
      thread: "the kickoff thread",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/Nothing was sent\.$/);
  });
});
