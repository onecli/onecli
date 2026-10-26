// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openConnectPopup } from "./connect-popup";

const opened = () => {
  const [url, name] = vi.mocked(window.open).mock.calls[0] ?? [];
  return {
    params: new URL(String(url), "http://localhost").searchParams,
    name,
  };
};

describe("openConnectPopup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries the connecting agent, so the new account lands on for it alone", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    openConnectPopup("gmail", {
      agentName: "Arik",
      agentId: "agent-7",
      workspaceId: "ws-1",
    });
    const { params, name } = opened();
    expect(params.get("agent_id")).toBe("agent-7");
    expect(params.get("agent_name")).toBe("Arik");
    expect(params.get("workspaceId")).toBe("ws-1");
    expect(name).toBe("connect-gmail-new");
  });

  it("names no agent for a workspace connect, so it lands on for none", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    openConnectPopup("gmail", { workspaceId: "ws-1" });
    expect(opened().params.has("agent_id")).toBe(false);
  });

  it("gives only the GitHub App its desktop-sized window", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const features = () => String(open.mock.lastCall?.[2]);
    openConnectPopup("github-app");
    expect(features()).toContain("width=1024");
    expect(features()).toContain("height=820");
    // The OAuth GitHub app's consent page fits the default window.
    openConnectPopup("github");
    expect(features()).toContain("width=520");
    expect(features()).toContain("height=700");
  });
});
