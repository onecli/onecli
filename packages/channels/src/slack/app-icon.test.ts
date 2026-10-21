import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadSlackAppIcon, isSlackAppIconUrl } from "./api";

/**
 * The app-icon download's host fence: the URL comes from a Slack answer, so
 * the server must only ever fetch Slack's avatar CDN, and never Slack's
 * stock marks (an icon-less app answers with those, observed live).
 */
describe("isSlackAppIconUrl", () => {
  it.each([
    "https://avatars.slack-edge.com/2026-10-18/123_abc_72.png",
    "https://ca.slack-edge.com/T0-U0-abc-72",
  ])("accepts an uploaded icon: %s", (url) => {
    expect(isSlackAppIconUrl(url)).toBe(true);
  });

  it.each([
    // The stock marks an app answers with before an icon is uploaded.
    "https://a.slack-edge.com/80588/img/plugins/app/bot_48.png",
    "https://a.slack-edge.com/80588/img/plugins/app/service_72.png",
    // Not https, a lookalike suffix, another origin, garbage.
    "http://avatars.slack-edge.com/x_72.png",
    "https://avatars.slack-edge.com.evil.example/x_72.png",
    "https://169.254.169.254/latest/meta-data",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isSlackAppIconUrl(url)).toBe(false);
  });
});

describe("downloadSlackAppIcon", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never fetches outside the fence", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      downloadSlackAppIcon("https://example.com/x.png", 10),
    ).rejects.toThrow(/not a Slack app icon URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses redirects and returns the bytes", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetch);
    const url = "https://avatars.slack-edge.com/x_72.png";
    expect(await downloadSlackAppIcon(url, 10)).toEqual(Buffer.from([1, 2, 3]));
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("stops at the byte cap, whatever the server declares", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(11))),
    );
    await expect(
      downloadSlackAppIcon("https://avatars.slack-edge.com/x_72.png", 10),
    ).rejects.toThrow(/too_large/);
  });

  it("throws on a non-2xx answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    await expect(
      downloadSlackAppIcon("https://avatars.slack-edge.com/x_72.png", 10),
    ).rejects.toThrow(/HTTP 404/);
  });
});
