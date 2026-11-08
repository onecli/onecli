import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startFakeSlackServer,
  type FakeSlackServer,
} from "@onecli/channels/slack/testing";
import { slackProvider } from "./provider";

/**
 * A platform report into a channel, and the channels it can go to, against
 * the fake Slack Web API (the client's one seam). Pinned to Slack's
 * documented forms:
 *  - a colored side bar is an attachment whose content is Block Kit
 *    `blocks` (its `text` + `mrkdwn_in` are legacy fields), each section
 *    under Slack's 3,000-char cap, which otherwise rejects the whole post;
 *  - "channels the bot is in" (`listChannels({ ownOnly })`) is
 *    `users.conversations` with the bot token, never the workspace-wide
 *    `conversations.list`, and a failed read is never answered with less.
 */

let slack: FakeSlackServer;
const credentialsJson = JSON.stringify({ botToken: "xoxb-proof" });

beforeAll(async () => {
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
});
beforeEach(() => {
  slack.calls.length = 0;
});
afterAll(async () => {
  await slack.close();
});

describe("sendMessage with sections", () => {
  it("posts each section as a colored attachment of mrkdwn section blocks", async () => {
    await slackProvider.sendMessage({
      credentialsJson,
      to: { kind: "channel", ref: "C0QA" },
      text: "**Dana's scheduled tests: 1 of 2 passed**",
      sections: [
        { tone: "bad", text: "**Needs a look**\n\n**2. Revenue?**" },
        { tone: "neutral", text: "[Open the full results](https://x.test/r)" },
      ],
    });
    const [post] = slack.callsTo("chat.postMessage");
    expect(post?.form.text).toBe("*Dana's scheduled tests: 1 of 2 passed*");
    expect(JSON.parse(post?.form.attachments ?? "null")).toEqual([
      {
        color: "#E0565B",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "*Needs a look*\n\n*2. Revenue?*" },
          },
        ],
      },
      {
        color: "#D0D4D9",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "<https://x.test/r|Open the full results>",
            },
          },
        ],
      },
    ]);
  });

  it("splits a long section under Slack's per-section cap instead of losing the post", async () => {
    const long = Array.from(
      { length: 80 },
      (_, i) => `${i}. ${"x".repeat(60)}`,
    ).join("\n");
    await slackProvider.sendMessage({
      credentialsJson,
      to: { kind: "channel", ref: "C0QA" },
      text: "headline",
      sections: [{ tone: "good", text: long }],
    });
    const [post] = slack.callsTo("chat.postMessage");
    const [attachment] = JSON.parse(post?.form.attachments ?? "[]") as {
      blocks: { text: { text: string } }[];
    }[];
    expect(attachment?.blocks.length).toBeGreaterThan(1);
    for (const block of attachment?.blocks ?? [])
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
  });

  it("posts no attachments without sections", async () => {
    await slackProvider.sendMessage({
      credentialsJson,
      to: { kind: "channel", ref: "C0QA" },
      text: "plain",
    });
    expect(slack.callsTo("chat.postMessage")[0]?.form).not.toHaveProperty(
      "attachments",
    );
  });
});

describe("listChannels({ ownOnly })", () => {
  it("asks users.conversations for the bot's own channels, paged, archived dropped", async () => {
    let page = 0;
    slack.respond("users.conversations", () => {
      page += 1;
      return page === 1
        ? {
            ok: true,
            channels: [
              { id: "C0QA", name: "qa", is_private: false },
              { id: "C0OLD", name: "old", is_archived: true },
            ],
            response_metadata: { next_cursor: "next" },
          }
        : {
            ok: true,
            channels: [{ id: "G0OPS", name: "ops", is_private: true }],
            response_metadata: { next_cursor: "" },
          };
    });
    expect(
      await slackProvider.listChannels({ credentialsJson, ownOnly: true }),
    ).toEqual([
      { ref: "C0QA", name: "qa", member: true, private: false },
      { ref: "G0OPS", name: "ops", member: true, private: true },
    ]);
    const calls = slack.callsTo("users.conversations");
    expect(calls.map((c) => c.form.cursor)).toEqual([undefined, "next"]);
    expect(calls[0]?.form.types).toBe("public_channel,private_channel");
    expect(calls[0]?.token).toBe("xoxb-proof");
    expect(slack.callsTo("conversations.list")).toHaveLength(0);
  });

  it("throws when the bot's own read fails, never falling back to the workspace walk", async () => {
    slack.respond("users.conversations", () => ({
      ok: false,
      error: "missing_scope",
    }));
    await expect(
      slackProvider.listChannels({ credentialsJson, ownOnly: true }),
    ).rejects.toThrow(/missing_scope/);
    expect(slack.callsTo("conversations.list")).toHaveLength(0);
  });
});
