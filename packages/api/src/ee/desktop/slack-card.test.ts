import { describe, expect, it } from "vitest";
import {
  DESKTOP_OPEN_ACTION,
  desktopRequestCardBlocks,
  settledDesktopCardText,
} from "./slack-card";

const flat = (blocks: unknown[]): string => JSON.stringify(blocks);

describe("desktopRequestCardBlocks", () => {
  it("escapes Slack syntax in the reason: the model can never mint a mention", () => {
    const rendered = flat(
      desktopRequestCardBlocks({
        agentName: "Donna",
        reason: "sign in <@U123> and <!channel> please",
        url: "https://app.example/w/ws/agents/a/computer?takeover=r1",
      }),
    );
    expect(rendered).not.toContain("<@U123>");
    expect(rendered).not.toContain("<!channel>");
    expect(rendered).toContain("&lt;@U123&gt;");
  });

  it("neutralizes a leading slash-command shape", () => {
    const rendered = flat(
      desktopRequestCardBlocks({
        agentName: "Donna",
        reason: "/invite everyone",
        url: "https://app.example/computer",
      }),
    );
    expect(rendered).toContain("\u2060/invite");
  });

  it("is one line and one URL button to the dashboard, no decision buttons, no value", () => {
    const blocks = desktopRequestCardBlocks({
      agentName: "Donna",
      reason: "sign in to the portal",
      url: "https://app.example/w/ws/agents/a/computer?takeover=r1",
    }) as {
      type: string;
      text?: { text: string };
      elements?: { action_id: string; url?: string; value?: string }[];
    }[];
    expect(blocks.map((b) => b.type)).toEqual(["section", "actions"]);
    expect(blocks[0]?.text?.text).toBe(
      "*Donna* needs you on its screen: sign in to the portal",
    );
    expect(blocks[1]?.elements).toHaveLength(1);
    expect(blocks[1]?.elements?.[0]).toMatchObject({
      action_id: DESKTOP_OPEN_ACTION,
      url: "https://app.example/w/ws/agents/a/computer?takeover=r1",
    });
    expect(blocks[1]?.elements?.[0]?.value).toBeUndefined();
  });

  it("clamps a runaway reason", () => {
    const rendered = flat(
      desktopRequestCardBlocks({
        agentName: "Donna",
        reason: "x".repeat(2000),
        url: "https://app.example/computer",
      }),
    );
    expect(rendered.length).toBeLessThan(1000);
  });
});

describe("settledDesktopCardText", () => {
  it("names who handled it and how it ended, escaped", () => {
    expect(
      settledDesktopCardText({
        reason: "sign in",
        outcome: "done",
        handledByName: "Alex <Kim>",
      }),
    ).toBe("\u2705 Alex &lt;Kim&gt; took over and is done: sign in");
    expect(
      settledDesktopCardText({
        reason: "sign in",
        outcome: "timeout",
        handledByName: "Alex",
      }),
    ).toBe("Alex’s control of the screen timed out: sign in");
    expect(
      settledDesktopCardText({
        reason: "sign in",
        outcome: "expired",
        handledByName: null,
      }),
    ).toBe("Expired: sign in");
  });
});
