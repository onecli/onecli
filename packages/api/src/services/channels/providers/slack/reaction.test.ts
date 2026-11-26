import { describe, expect, it } from "vitest";
import { interpretSlackEvent } from "./interpret";
import { reactionNote } from "./reaction";

const BOT = "UBOT";
const ctx = { botUserId: BOT };
const ev = (over: Record<string, unknown> = {}) => ({
  type: "reaction_added",
  user: "UPERSON",
  reaction: "+1",
  item_user: BOT,
  item: { type: "message", channel: "D123", ts: "1.1", channel_type: "im" },
  ...over,
});

describe("interpretSlackEvent: reaction_added", () => {
  it("a person's reaction on the agent's message reaches the reaction door", () => {
    expect(interpretSlackEvent(ev(), ctx)).toEqual({
      door: "reaction",
      externalUserId: "UPERSON",
      channel: "D123",
      inDm: true,
      itemTs: "1.1",
      reaction: "+1",
    });
  });

  it("passes a message with NO author on to the re-read: the agent's icon-posted answer has none", () => {
    const noAuthor = { ...ev(), item_user: undefined };
    expect(interpretSlackEvent(noAuthor, ctx).door).toBe("reaction");
  });

  it("drops a reaction on a message another person wrote", () => {
    expect(interpretSlackEvent(ev({ item_user: "UOTHER" }), ctx)).toEqual({
      door: "ignore",
      reason: "reaction:not-on-agent-message",
    });
  });

  it("drops the agent's own reactions (its seen receipt) and Slack's system users", () => {
    expect(interpretSlackEvent(ev({ user: BOT }), ctx).door).toBe("ignore");
    expect(interpretSlackEvent(ev({ user: "USLACKBOT" }), ctx).door).toBe(
      "ignore",
    );
  });

  it("drops everything when the agent's own id is unknown", () => {
    expect(interpretSlackEvent(ev(), { botUserId: null })).toEqual({
      door: "ignore",
      reason: "reaction:unverifiable-self",
    });
  });

  it("drops a reaction on a file, and a malformed event, without throwing", () => {
    for (const malformed of [
      ev({ item: { type: "file", file: "F1" } }),
      ev({ item: undefined }),
      ev({ item: { type: "message", channel: "D1" } }),
      ev({ reaction: undefined }),
    ]) {
      expect(interpretSlackEvent(malformed, ctx)).toEqual({
        door: "ignore",
        reason: "reaction:not-a-message",
      });
    }
  });

  it("reads the DM from Slack's channel_type, and from the IM id when it is absent", () => {
    const at = (item: Record<string, unknown>) => {
      const call = interpretSlackEvent(ev({ item }), ctx);
      return call.door === "reaction" ? call.inDm : null;
    };
    const base = { type: "message", ts: "1.1" };
    expect(at({ ...base, channel: "C1", channel_type: "channel" })).toBe(false);
    expect(at({ ...base, channel: "D1", channel_type: "im" })).toBe(true);
    expect(at({ ...base, channel: "D1" })).toBe(true);
    expect(at({ ...base, channel: "C1" })).toBe(false);
    expect(at({ ...base, channel: "G1" })).toBe(false);
  });
});

describe("reactionNote", () => {
  it("reads a thumbs up as yes and quotes only the first line", () => {
    const note = reactionNote("+1", "Should I send it?\nmore detail");
    expect(note).toContain(":+1: (read as: yes / approved)");
    expect(note).toContain('"Should I send it?"');
    expect(note).not.toContain("more detail");
  });

  it("reads a toned thumbs up as yes too, and names the emoji without the tone", () => {
    const note = reactionNote("+1::skin-tone-4", "Send it?");
    expect(note).toContain(":+1: (read as: yes / approved)");
    expect(note).not.toContain("skin-tone");
  });

  it("reads a thumbs down as no, and any other emoji with no meaning", () => {
    expect(reactionNote("-1::skin-tone-2", "x")).toContain(
      "(read as: no / declined)",
    );
    expect(reactionNote("joy", "x")).not.toContain("read as");
  });

  it("lets the agent stay silent with the platform's own no-reply token", () => {
    expect(reactionNote("joy", "x")).toContain("answer exactly [no reply]");
  });

  it("clamps the quote and strips control and format characters", () => {
    const note = reactionNote("+1", `${"a".repeat(500)}\u202e`);
    expect(note).toContain(`"${"a".repeat(200)}"`);
    expect(note).not.toContain("\u202e");
    expect(reactionNote("+1", "")).toContain('your message: ""');
  });
});
