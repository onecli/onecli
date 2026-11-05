import { describe, expect, it } from "vitest";
import {
  approvalButtons,
  approvalClickOf,
  decidedText,
  similarNoteBlocks,
} from "./approve-similar";

const offer = {
  label: "Attio updates to companies",
  windowMinutes: 15,
  maxRequests: 100,
};

const click = (actionId: unknown, value: unknown = "ap-1") => ({
  type: "block_actions",
  user: { id: "U1" },
  actions: [{ action_id: actionId, value }],
});

describe("approvalClickOf", () => {
  it("reads the three buttons, the id alone and the clicker", () => {
    expect(approvalClickOf(click("channel_approve"))).toEqual({
      approvalId: "ap-1",
      decision: "approve",
      clickerExternalUserId: "U1",
    });
    expect(approvalClickOf(click("channel_deny"))).toEqual({
      approvalId: "ap-1",
      decision: "deny",
      clickerExternalUserId: "U1",
    });
    expect(approvalClickOf(click("channel_approve_similar"))).toEqual({
      approvalId: "ap-1",
      decision: "approve",
      scope: "similar",
      clickerExternalUserId: "U1",
    });
  });

  it("ignores every other click and every malformed one", () => {
    for (const payload of [
      click("group_approve"),
      click("channel_approve_similar_x"),
      click("channel_approve", ""),
      click("channel_approve", 42),
      click("channel_approve", "x".repeat(501)),
      { ...click("channel_approve"), type: "view_submission" },
      { ...click("channel_approve"), user: {} },
      { type: "block_actions", user: { id: "U1" } },
      null,
      "payload",
    ]) {
      expect(approvalClickOf(payload)).toBeNull();
    }
  });
});

describe("approvalButtons", () => {
  const ids = (similar: typeof offer | null) =>
    approvalButtons("ap-1", similar).map((b) => {
      const button = b as {
        action_id: string;
        value: string;
        text: { text: string };
      };
      return [button.action_id, button.value, button.text.text];
    });

  it("adds Approve similar between Approve and Deny only when offered, valued with the id alone", () => {
    expect(ids(null)).toEqual([
      ["channel_approve", "ap-1", "Approve"],
      ["channel_deny", "ap-1", "Deny"],
    ]);
    expect(ids(offer)).toEqual([
      ["channel_approve", "ap-1", "Approve"],
      ["channel_approve_similar", "ap-1", "Approve similar · 15 min"],
      ["channel_deny", "ap-1", "Deny"],
    ]);
  });
});

describe("similarNoteBlocks", () => {
  it("says what the window covers and its bounds", () => {
    expect(JSON.stringify(similarNoteBlocks(offer, "Sam's bot"))).toContain(
      "_Approve similar also allows up to 100 more Attio updates to companies from Sam's bot._",
    );
    expect(similarNoteBlocks(null, "Sam's bot")).toEqual([]);
  });

  it("escapes the label and the agent name", () => {
    const note = JSON.stringify(
      similarNoteBlocks({ ...offer, label: "x <@U1> y" }, "<!channel>"),
    );
    expect(note).not.toContain("<!channel>");
    expect(note).not.toContain("<@U1>");
  });
});

describe("decidedText", () => {
  it("says who decided, escaped", () => {
    expect(decidedText("approve", "Ada <!here>")).toBe(
      "✅ Approved by Ada &lt;!here&gt;",
    );
    expect(decidedText("deny", "Ada")).toBe("⛔ Denied by Ada");
  });

  it("names the opened window and its end in the reader's time zone", () => {
    expect(
      decidedText("approve", "Ada", {
        label: "Attio updates to <companies>",
        until: "2026-11-03T17:22:00Z",
      }),
    ).toBe(
      "✅ Approved by Ada · Attio updates to &lt;companies&gt; allowed until <!date^1793726520^{time}|17:22 UTC>",
    );
  });

  it("drops the end when it is not a time, never breaking the token", () => {
    expect(
      decidedText("approve", "Ada", {
        label: "Attio updates to companies",
        until: "soon|<!channel>",
      }),
    ).toBe("✅ Approved by Ada · Attio updates to companies allowed");
  });
});
