import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Discord operator notifications never fire off cloud ─────────────────────
//
// They post into OUR Discord — a hosted-platform surface, not product
// behavior. The gate sits at the single choke point every caller shares
// (session hooks, reviewer logins, Resend replies, Stripe events), so a
// self-host that inherits a DISCORD_WEBHOOK_URL — a copied env file, an
// ambient shell, a lifted compose block — still posts nothing.
//
// The config-absent path proves nothing here (no URL, no fetch either way), so
// the URL is deliberately SET in both arms: the only difference is the edition.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  process.env.DISCORD_WEBHOOK_URL = "https://discord.invalid/webhook";
});

const { notifyDiscord } = await import("./discord");
const { IS_CLOUD } = await import("../../lib/env");

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("notifyDiscord on a self-host", () => {
  it("premise: this lane is not cloud, and a webhook URL IS configured", () => {
    // Without both, a silent no-op below would prove nothing.
    expect(IS_CLOUD).toBe(false);
    expect(process.env.DISCORD_WEBHOOK_URL).toBeTruthy();
  });

  it("posts nothing, even with the URL configured", () => {
    notifyDiscord("user_signup", { email: "someone@example.com" });
    notifyDiscord("email_reply", { from: "a@b.c", subject: "hi" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
