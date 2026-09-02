import type { ChannelProviderId } from "./types";

/**
 * A channel provider's API refusal, carrying the provider's own error code
 * verbatim — the plan requires codes like `managed_app_limit_reached` to
 * reach the user unaltered, so the code is the message.
 *
 * The NEUTRAL base the generic layer (the error handler's 422 mapping)
 * branches on; each provider's concrete error (Slack: `SlackApiError`)
 * extends it. Lives here rather than beside `ServiceError` because the
 * providerId ties it to the channel registry's vocabulary.
 */
export class ChannelProviderApiError extends Error {
  constructor(
    public readonly providerId: ChannelProviderId,
    public readonly method: string,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChannelProviderApiError";
  }
}
