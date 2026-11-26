import { afterEach, describe, expect, it, vi } from "vitest";
import { slackReach } from "./reach-card";

const input = {
  credentialsJson: JSON.stringify({ botToken: "xoxb-fictional" }),
  externalRef: "C_FICTIONAL_ROOM",
};

afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, status = 200, headers?: HeadersInit) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

describe("Slack membership evidence", () => {
  it.each([false, true])(
    "membership remains true when archived=%s",
    async (is_archived) => {
      answer({
        ok: true,
        channel: { id: input.externalRef, is_member: true, is_archived },
      });
      expect(await slackReach.spaceMembership(input)).toEqual({
        kind: "member",
      });
    },
  );

  it("explicit non-membership is gone", async () => {
    answer({ ok: true, channel: { id: input.externalRef, is_member: false } });
    expect(await slackReach.spaceMembership(input)).toEqual({ kind: "gone" });
  });

  it("channel_not_found is gone", async () => {
    answer({ ok: false, error: "channel_not_found" });
    expect(await slackReach.spaceMembership(input)).toEqual({ kind: "gone" });
  });

  it.each([
    { ok: true, channel: { id: input.externalRef, is_archived: true } },
    { ok: true, channel: { id: input.externalRef, is_member: "true" } },
    { ok: true },
    { ok: false, error: "missing_scope" },
    { ok: false, error: "invalid_auth" },
  ])("ambiguous or malformed evidence is unknown: %j", async (body) => {
    answer(body);
    expect(await slackReach.spaceMembership(input)).toEqual({
      kind: "unknown",
    });
  });

  it.each([null, "malformed", "{}"])(
    "unavailable credentials are unknown: %s",
    async (credentialsJson) => {
      const fetcher = answer({});
      expect(
        await slackReach.spaceMembership({ ...input, credentialsJson }),
      ).toEqual({ kind: "unknown" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("retains rate limit cooldown without retrying early", async () => {
    const fetcher = answer({}, 429, { "Retry-After": "30" });
    expect(await slackReach.spaceMembership(input)).toEqual({
      kind: "unknown",
      retryAfterMs: 30_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("transport failures remain unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fictional offline")),
    );
    expect(await slackReach.spaceMembership(input)).toEqual({
      kind: "unknown",
    });
  });

  it("thread prefix includes a strict separator", () => {
    expect(slackReach.spaceThreadPrefix("C_ROOM")).toBe("C_ROOM:");
    expect(
      "C_ROOM_OTHER:1".startsWith(slackReach.spaceThreadPrefix("C_ROOM")),
    ).toBe(false);
  });
});
