import { beforeEach, describe, expect, it, vi } from "vitest";

// syncAgentPresenceNames' contract: NEVER throws (its caller fires it with a
// bare `void` — a rejection anywhere would be an unhandled rejection that
// kills the api-server), presence-filtered to the live statuses, and a
// provider without the optional hook is skipped, not crashed.

const db = vi.hoisted(() => ({
  agentChannel: { findMany: vi.fn() },
}));
vi.mock("@onecli/db", () => ({ db, Prisma: {} }));

const seams = vi.hoisted(() => ({
  syncRemotePresenceName: vi.fn(),
  /** What channelProvider answers — a test swaps it for a hook-less one. */
  provider: {} as Record<string, unknown>,
  withFreshIntegrationCredentials: vi.fn(
    async (
      _org: string,
      _provider: string,
      fn: (token: string) => Promise<unknown>,
    ) => fn("xoxe-config-token"),
  ),
}));

vi.mock("./registry", () => ({
  channelProvider: () => seams.provider,
  presenceSettingsUrlFor: () => null,
}));

vi.mock("./channel-integration-service", () => ({
  withFreshIntegrationCredentials: seams.withFreshIntegrationCredentials,
}));

const { syncAgentPresenceNames } = await import("./agent-channel-service");

const AGENT = { id: "ag1", organizationId: "org1" };

beforeEach(() => {
  vi.clearAllMocks();
  seams.provider = { syncRemotePresenceName: seams.syncRemotePresenceName };
  db.agentChannel.findMany.mockResolvedValue([
    { provider: "slack", externalId: "A1" },
  ]);
});

describe("syncAgentPresenceNames", () => {
  it("pushes the new name through fresh integration credentials", async () => {
    await syncAgentPresenceNames(AGENT, "New Name");
    expect(db.agentChannel.findMany).toHaveBeenCalledWith({
      where: {
        agentId: "ag1",
        status: { in: ["active", "needs_attention"] },
      },
      select: { provider: true, externalId: true },
    });
    expect(seams.syncRemotePresenceName).toHaveBeenCalledWith({
      accessToken: "xoxe-config-token",
      externalId: "A1",
      name: "New Name",
    });
  });

  it("NEVER throws — a provider refusal is swallowed per presence", async () => {
    db.agentChannel.findMany.mockResolvedValue([
      { provider: "slack", externalId: "A1" },
      { provider: "slack", externalId: "A2" },
    ]);
    seams.syncRemotePresenceName.mockRejectedValueOnce(
      new Error("provider down"),
    );
    await expect(
      syncAgentPresenceNames(AGENT, "New Name"),
    ).resolves.toBeUndefined();
    // The failure on A1 did not stop A2 — best-effort PER presence.
    expect(seams.syncRemotePresenceName).toHaveBeenCalledTimes(2);
  });

  it("skips a provider without the optional hook — extend, never crash", async () => {
    seams.provider = {};
    await expect(
      syncAgentPresenceNames(AGENT, "New Name"),
    ).resolves.toBeUndefined();
    expect(seams.withFreshIntegrationCredentials).not.toHaveBeenCalled();
  });

  it("NEVER throws — even the presence lookup rejecting is a logged skip", async () => {
    // The mutation this pins: pull the findMany inside-the-try wrap and this
    // rejection escapes to the `void` call site as an unhandled rejection.
    db.agentChannel.findMany.mockRejectedValue(new Error("db blip"));
    await expect(
      syncAgentPresenceNames(AGENT, "New Name"),
    ).resolves.toBeUndefined();
  });
});
