import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROVIDER_IDS,
  ChannelProviderApiError,
  isDeadCredentialError,
} from "./errors";
import { SlackApiError } from "./slack/api";

describe("isDeadCredentialError — the codes that mean 'the app is gone'", () => {
  // The generic layer flips a presence to disabled on these exactly as it
  // does for the uninstall webhook. The table must stay narrow: a widened
  // set turns a rate limit or a missing scope into a false "your app was
  // removed". MUTATION-PROOF: add "ratelimited" to the Slack set and the
  // control below fails; drop "account_inactive" and the deleted-app case
  // stops flipping.
  it("recognizes Slack's documented dead-bot-token refusals", () => {
    for (const code of ["account_inactive", "token_revoked", "invalid_auth"]) {
      expect(
        isDeadCredentialError(new SlackApiError("chat.postMessage", code)),
      ).toBe(true);
    }
  });

  it("does NOT treat call-specific or transient refusals as removal", () => {
    for (const code of [
      "ratelimited",
      "missing_scope",
      "channel_not_found",
      "not_in_channel",
      "internal_error",
      "not_authed", // no token sent: a caller bug, not a dead credential
      "token_expired", // rotating user tokens; a bot token never expires
    ]) {
      expect(
        isDeadCredentialError(new SlackApiError("chat.postMessage", code)),
      ).toBe(false);
    }
  });

  it("answers false for anything that is not a provider refusal", () => {
    expect(isDeadCredentialError(new Error("account_inactive"))).toBe(false);
    expect(isDeadCredentialError("account_inactive")).toBe(false);
    expect(isDeadCredentialError(undefined)).toBe(false);
  });

  it("every provider id has a vouched code set (adding a provider without one is a compile error, and this pins it at runtime too)", () => {
    for (const id of CHANNEL_PROVIDER_IDS) {
      // An unknown code is never dead, whatever the provider.
      expect(
        isDeadCredentialError(
          new ChannelProviderApiError(id, "m", "definitely_not_a_code", "x"),
        ),
      ).toBe(false);
    }
  });
});
