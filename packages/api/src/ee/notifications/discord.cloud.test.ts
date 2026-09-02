import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cloud arm of the Discord notification gate: the same call that posts nothing
 * on a self-host (discord.onprem.test.ts) DOES post here. Only the edition pin
 * differs — without this arm, the onprem test would pass just as well against
 * a notifyDiscord that never posted anywhere.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
  process.env.DISCORD_WEBHOOK_URL = "https://discord.invalid/webhook";
});

const { notifyDiscord } = await import("./discord");

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("notifyDiscord on cloud", () => {
  it("posts the event to the configured webhook", () => {
    notifyDiscord("user_signup", { email: "someone@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://discord.invalid/webhook");
    expect(init.body).toContain("someone@example.com");
  });
});
