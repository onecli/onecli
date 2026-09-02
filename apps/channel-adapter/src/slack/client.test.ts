import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeSlackServer, type FakeSlackServer } from "../test/fakes";
import {
  postBlocks,
  postMessage,
  resetIconlessBotTokensForTests,
  SlackApiError,
} from "./client";

// The icon-carrying post contract: `icon_url` rides when an avatar is set,
// a `missing_scope` refusal (an install predating `chat:write.customize`)
// retries plain EXACTLY once and is memoized per bot token, and every other
// refusal still throws. Real HTTP against the fake Slack server — the
// adapter's one seam (`SLACK_API_BASE_URL`), no mocked modules.

const ICON = "https://api.example.com/v1/agent-images/ag1/aaaa";

let slack: FakeSlackServer;

beforeEach(async () => {
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
  resetIconlessBotTokensForTests();
});

afterEach(async () => {
  delete process.env.SLACK_API_BASE_URL;
  await slack.close();
});

/** Script `missing_scope` for icon-carrying posts only — the fallback's
 * plain retry must then succeed, exactly like real Slack. */
const refuseIconPosts = () => {
  slack.respond("chat.postMessage", (form) =>
    "icon_url" in form
      ? { ok: false, error: "missing_scope" }
      : { ok: true, channel: form.channel ?? "C0", ts: "1700.0001" },
  );
};

describe("postMessage", () => {
  it("carries icon_url when an avatar is set — and omits it when not", async () => {
    await postMessage("xoxb-a", { channel: "D1", text: "hi", iconUrl: ICON });
    await postMessage("xoxb-a", { channel: "D1", text: "plain" });
    const [withIcon, plain] = slack.callsTo("chat.postMessage");
    expect(withIcon?.form.icon_url).toBe(ICON);
    expect("icon_url" in (plain?.form ?? {})).toBe(false);
  });

  it("missing_scope retries plain once — the answer lands without the icon", async () => {
    refuseIconPosts();
    const posted = await postMessage("xoxb-old", {
      channel: "D1",
      text: "hi",
      iconUrl: ICON,
    });
    expect(posted.ts).toBe("1700.0001");
    const calls = slack.callsTo("chat.postMessage");
    expect(calls).toHaveLength(2);
    expect("icon_url" in (calls[1]?.form ?? {})).toBe(false);
  });

  it("memoizes the verdict per bot token — the NEXT post never re-probes", async () => {
    refuseIconPosts();
    await postMessage("xoxb-old", { channel: "D1", text: "a", iconUrl: ICON });
    await postMessage("xoxb-old", { channel: "D1", text: "b", iconUrl: ICON });
    // 2 for the probe+retry, then exactly 1 plain post — not 2 more.
    const calls = slack.callsTo("chat.postMessage");
    expect(calls).toHaveLength(3);
    expect("icon_url" in (calls[2]?.form ?? {})).toBe(false);
  });

  it("a DIFFERENT bot token still probes — the memo is per token", async () => {
    refuseIconPosts();
    await postMessage("xoxb-old", { channel: "D1", text: "a", iconUrl: ICON });
    slack.respond("chat.postMessage", (form) => ({
      ok: true,
      channel: form.channel ?? "C0",
      ts: "1700.0009",
    }));
    await postMessage("xoxb-new", { channel: "D1", text: "b", iconUrl: ICON });
    const last = slack.callsTo("chat.postMessage").at(-1);
    expect(last?.form.icon_url).toBe(ICON);
  });

  it("the verdict EXPIRES — Slack keeps the token across a scope-granting reinstall, so a permanent memo would strip icons forever", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      refuseIconPosts();
      await postMessage("xoxb-old", {
        channel: "D1",
        text: "a",
        iconUrl: ICON,
      });
      // The user reinstalls (same token, scope granted) and the window laps.
      slack.respond("chat.postMessage", (form) => ({
        ok: true,
        channel: form.channel ?? "C0",
        ts: "1700.0010",
      }));
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      await postMessage("xoxb-old", {
        channel: "D1",
        text: "b",
        iconUrl: ICON,
      });
      const last = slack.callsTo("chat.postMessage").at(-1);
      expect(last?.form.icon_url).toBe(ICON);
    } finally {
      vi.useRealTimers();
    }
  });

  it("any OTHER refusal rethrows — the fallback is the missing_scope carve only", async () => {
    slack.respond("chat.postMessage", () => ({
      ok: false,
      error: "channel_not_found",
    }));
    await expect(
      postMessage("xoxb-a", { channel: "DX", text: "hi", iconUrl: ICON }),
    ).rejects.toThrow(SlackApiError);
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
  });
});

describe("postBlocks", () => {
  it("carries icon_url on the approval card and shares the missing_scope carve", async () => {
    await postBlocks("xoxb-a", {
      channel: "D1",
      text: "Approval needed",
      blocks: [{ type: "section" }],
      iconUrl: ICON,
    });
    expect(slack.callsTo("chat.postMessage")[0]?.form.icon_url).toBe(ICON);

    refuseIconPosts();
    const posted = await postBlocks("xoxb-old", {
      channel: "D1",
      text: "Approval needed",
      blocks: [{ type: "section" }],
      iconUrl: ICON,
    });
    expect(posted.ts).toBe("1700.0001");
    // Probe + plain retry, and the blocks payload survived the retry.
    const calls = slack.callsTo("chat.postMessage").slice(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.form.blocks).toContain("section");
    expect("icon_url" in (calls[1]?.form ?? {})).toBe(false);
  });

  it("shares the per-token memo with postMessage", async () => {
    refuseIconPosts();
    await postMessage("xoxb-old", { channel: "D1", text: "a", iconUrl: ICON });
    await postBlocks("xoxb-old", {
      channel: "D1",
      text: "card",
      blocks: [],
      iconUrl: ICON,
    });
    // The blocks post inherited the verdict: 2 probe calls, then 1 plain.
    expect(slack.callsTo("chat.postMessage")).toHaveLength(3);
  });
});
