/**
 * Provider identity and the provider-error base — the vocabulary BOTH
 * runtimes (the api's control plane and the channel-adapter) share.
 *
 * This lives here, below both, because it is what ties the shared wire
 * clients to the generic layers above them: the api's channel registry keys
 * its `Record` on this union (so adding a provider without a registry entry
 * is a compile error), and the api's error handler maps the error base to a
 * 422 without knowing any provider's concrete error class.
 *
 * Adding a provider (Teams, Telegram, WhatsApp):
 *   1. extend `CHANNEL_PROVIDER_IDS`;
 *   2. add `src/<provider>/` with its wire client (its concrete error
 *      extends `ChannelProviderApiError`);
 *   3. the api's registry `Record` now fails to compile until the provider
 *      entry exists — which is the point.
 */

export const CHANNEL_PROVIDER_IDS = ["slack"] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDER_IDS)[number];

export const isChannelProviderId = (raw: string): raw is ChannelProviderId =>
  (CHANNEL_PROVIDER_IDS as readonly string[]).includes(raw);

/**
 * A channel provider's API refusal, carrying the provider's own error code
 * verbatim — codes like `managed_app_limit_reached` must reach the user
 * unaltered, so the code is the message.
 *
 * The NEUTRAL base the generic layer (the api error handler's 422 mapping)
 * branches on; each provider's concrete error (Slack: `SlackApiError`)
 * extends it.
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
