import { describe, expect, it } from "vitest";
import type { SlackHistoryMessage } from "@onecli/channels/slack";
import type { OwnReplyTarget } from "../../types";
import { isPlainReply } from "./own-replies";

const target: OwnReplyTarget = {
  credentialsJson: "{}",
  externalId: "A0OWNAPP",
  identityRef: "U0OWNBOT",
  externalThreadId: "D0DM",
  kind: "direct",
  sourceThreadId: null,
};

// Shapes copied from a real Slack DM's conversations.history: Slack adds a
// rich_text block to every plain-text post on its own.
const plainAnswer: SlackHistoryMessage = {
  ts: "1793281974.188949",
  app_id: "A0OWNAPP",
  bot_id: "B0OWNBOT",
  subtype: "bot_message",
  text: "Tokyo, for the food.",
  blocks: [{ type: "rich_text", block_id: "x", elements: [] }],
};

describe("isPlainReply", () => {
  it("keeps a plain answer that carries Slack's auto rich_text block", () => {
    expect(isPlainReply(plainAnswer, target)).toBe(true);
  });

  it("keeps a plain answer with no blocks", () => {
    expect(isPlainReply({ ...plainAnswer, blocks: undefined }, target)).toBe(
      true,
    );
  });

  it("drops a card (section/context/actions blocks)", () => {
    expect(
      isPlainReply(
        {
          ...plainAnswer,
          blocks: [{ type: "context" }, { type: "section" }],
        },
        target,
      ),
    ).toBe(false);
    expect(
      isPlainReply(
        {
          ...plainAnswer,
          blocks: [{ type: "rich_text" }, { type: "actions" }],
        },
        target,
      ),
    ).toBe(false);
  });

  it("drops the web mirror's copy of a person's words", () => {
    expect(
      isPlainReply(
        { ...plainAnswer, text: "_(:globe_with_meridians: · Jo)_ hi" },
        target,
      ),
    ).toBe(false);
  });

  it("drops another app's post and bookkeeping subtypes", () => {
    expect(isPlainReply({ ...plainAnswer, app_id: "A0OTHER" }, target)).toBe(
      false,
    );
    expect(
      isPlainReply({ ...plainAnswer, subtype: "channel_join" }, target),
    ).toBe(false);
  });
});
