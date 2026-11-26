import { describe, expect, it } from "vitest";
import { connectedPresences, isPresenceConnected } from "./channel-providers";
import {
  CHANNEL_PROVIDER_UIS,
  channelProviderUi,
} from "./channel-providers/registry";

/**
 * The connected-mark law, provider-neutral: a presence row exists from the
 * first attach click (`pending_setup`) and stays after the workspace removes
 * the app (`disabled`), so existence is not connection. The predicate draws
 * the same line the Channels section draws for its attached face — for
 * EVERY provider, since the marks iterate presences and look the provider
 * up by id rather than naming one.
 */
describe("isPresenceConnected / connectedPresences", () => {
  it("a pending_setup presence is NOT connected — the mark must not lie", () => {
    expect(isPresenceConnected({ status: "pending_setup" })).toBe(false);
  });

  it("an active presence is connected", () => {
    expect(isPresenceConnected({ status: "active" })).toBe(true);
  });

  it("a disabled presence (removed on the provider's side) is NOT connected", () => {
    expect(isPresenceConnected({ status: "disabled" })).toBe(false);
  });

  it("needs_attention still counts — the section renders it as attached", () => {
    expect(isPresenceConnected({ status: "needs_attention" })).toBe(true);
  });

  it("a missing status (older API during deploy skew) reads as connected", () => {
    expect(isPresenceConnected({})).toBe(true);
  });

  it("connectedPresences keeps every connected row, any provider, in order", () => {
    expect(
      connectedPresences([
        { provider: "slack", status: "pending_setup" },
        { provider: "teams", status: "active" },
        { provider: "slack", status: "active" },
        { provider: "slack", status: "disabled" },
      ]).map((p) => `${p.provider}:${p.status}`),
    ).toEqual(["teams:active", "slack:active"]);
    expect(connectedPresences([])).toEqual([]);
    expect(connectedPresences(undefined)).toEqual([]);
  });
});

describe("the web channel-provider registry", () => {
  it("looks a provider up by id and answers null for one this build does not know", () => {
    expect(channelProviderUi("slack")?.name).toBe("Slack");
    expect(channelProviderUi("teams")).toBeNull();
    expect(channelProviderUi("constructor")).toBeNull();
  });

  it("every entry carries display facts and both cards", () => {
    for (const ui of CHANNEL_PROVIDER_UIS) {
      expect(ui.id.length).toBeGreaterThan(0);
      expect(ui.name.length).toBeGreaterThan(0);
      expect(ui.iconSrc.startsWith("/icons/")).toBe(true);
      expect(typeof ui.PresenceCard).toBe("function");
      expect(typeof ui.AttachCard).toBe("function");
    }
  });
});
