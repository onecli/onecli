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

/**
 * Whether a provider refusal means the presence's credential is DEAD — the
 * app was uninstalled, deleted, or its token revoked — as opposed to a
 * transient or call-specific refusal (rate limit, missing scope, bad
 * channel). The generic layer flips the presence to `disabled` on a dead
 * credential exactly as it does for the provider's uninstall webhook, which
 * is what covers the cases no webhook reaches: an app DELETED at
 * api.slack.com (Slack's `app_deleted` event is org-admin only), a webhook
 * lost while the adapter was offline, or an app created before the manifest
 * subscribed to the removal events.
 *
 * Per provider, the codes the provider documents as terminal for its bot
 * token (Slack, docs.slack.dev/reference/methods/chat.postMessage, checked
 * 2026-09-15): `account_inactive` ("token is for a deleted user or workspace
 * when using a bot token"), `token_revoked` ("the app has been removed"),
 * `invalid_auth` ("the provided token is invalid"). `not_authed` is a
 * caller bug (no token sent) and `token_expired` belongs to rotating user
 * tokens, so neither is here. Unknown providers answer false: never flip on
 * a code this table has not vouched for.
 */
export const isDeadCredentialError = (error: unknown): boolean =>
  error instanceof ChannelProviderApiError &&
  (DEAD_CREDENTIAL_CODES[error.providerId]?.has(error.code) ?? false);

const DEAD_CREDENTIAL_CODES: Record<ChannelProviderId, ReadonlySet<string>> = {
  slack: new Set(["account_inactive", "token_revoked", "invalid_auth"]),
};
