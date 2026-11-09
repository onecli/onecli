import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The client's landing lookups: the final page in one hop when the server
 * answers, and the forwarding URL (which lands in the same place, one hop
 * later) when it does not, so a blip never turns a navigation into an
 * error.
 */

const mocks = vi.hoisted(() => ({
  workspaceLandingAction: vi.fn(),
  orgLandingAction: vi.fn(),
  defaultLandingAction: vi.fn(),
}));
vi.mock("@/lib/workspaces/actions", () => mocks);

const { orgLanding, workspaceLanding } =
  await import("@/lib/dashboard/landing");
const { postAuthLanding } = await import("@/lib/auth/post-auth-landing");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceLandingAction.mockResolvedValue("/w/ws1/agents/ag1/chat");
  mocks.orgLandingAction.mockResolvedValue("/w/ws2/agents/ag2/chat");
  mocks.defaultLandingAction.mockResolvedValue("/w/ws3/agents/ag3/chat");
});

describe("workspaceLanding / orgLanding", () => {
  it("answer the server's final page", async () => {
    await expect(workspaceLanding("ws1")).resolves.toBe(
      "/w/ws1/agents/ag1/chat",
    );
    await expect(orgLanding("org2")).resolves.toBe("/w/ws2/agents/ag2/chat");
    expect(mocks.workspaceLandingAction).toHaveBeenCalledWith("ws1");
    expect(mocks.orgLandingAction).toHaveBeenCalledWith("org2");
  });

  it("answer the forwarding URL when the lookup fails", async () => {
    mocks.workspaceLandingAction.mockRejectedValue(new Error("deploy"));
    mocks.orgLandingAction.mockRejectedValue(new Error("deploy"));
    await expect(workspaceLanding("ws1")).resolves.toBe("/w/ws1");
    await expect(orgLanding("org2")).resolves.toBe("/org/org2/workspaces");
  });
});

describe("postAuthLanding", () => {
  it("lands on the session's workspace's first agent", async () => {
    await expect(postAuthLanding("ws1")).resolves.toBe(
      "/w/ws1/agents/ag1/chat",
    );
    expect(mocks.defaultLandingAction).not.toHaveBeenCalled();
  });

  it("lands on the default org's first agent with no workspace in the session", async () => {
    await expect(postAuthLanding(undefined)).resolves.toBe(
      "/w/ws3/agents/ag3/chat",
    );
  });

  it("sends an org-less account to org creation", async () => {
    mocks.defaultLandingAction.mockResolvedValue(null);
    await expect(postAuthLanding(undefined)).resolves.toBe("/create-org");
  });

  it("falls back to /org, which resolves server-side, when the lookup fails", async () => {
    mocks.defaultLandingAction.mockRejectedValue(new Error("deploy"));
    await expect(postAuthLanding(undefined)).resolves.toBe("/org");
  });
});
