// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The top bar's Slack chip reads the agent's channels, which only a hosted
 * agent has: the API refuses the read for a BYO agent (422), so the chip
 * must not ask for one.
 */

const asked = vi.hoisted((): { ids: string[] } => ({ ids: [] }));
vi.mock("@/hooks/use-channels", () => ({
  useAgentChannels: (agentId: string) => {
    asked.ids.push(agentId);
    return { data: undefined };
  },
}));

const { SlackChip } = await import("./slack-chip");

afterEach(() => {
  cleanup();
  asked.ids = [];
});

describe("SlackChip", () => {
  it("never reads a BYO agent's channels", () => {
    render(
      <SlackChip
        workspaceId="ws1"
        agent={{ id: "a1", name: "B", kind: "byo" }}
      />,
    );
    expect(asked.ids.every((id) => id === "")).toBe(true);
  });

  it("reads a hosted agent's channels", () => {
    render(
      <SlackChip
        workspaceId="ws1"
        agent={{ id: "a2", name: "H", kind: "hosted" }}
      />,
    );
    expect(asked.ids).toContain("a2");
  });
});
