import type { ChannelProvider, ChannelProviderId } from "./types";
import { slackProvider } from "./providers/slack/provider";

// SERVER-ONLY (see `./types`): providers reach outbound fetch logic and
// decrypted credentials. Client code gets its data from the channel routes.

/**
 * Every channel provider — THE one list, mirroring `llm/registry.ts`: a
 * `Record` keyed by the id union, so adding a provider to
 * `ChannelProviderId` without adding it here is a compile error, and
 * everything else derives from it rather than being repeated beside it.
 */
export const CHANNEL_PROVIDERS: Record<ChannelProviderId, ChannelProvider> = {
  slack: slackProvider,
};

/**
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so
 * `"constructor"` would answer true and hand back something that is not a
 * provider (the same trap `llm/registry.ts` documents).
 */
export const isChannelProviderId = (
  value: string,
): value is ChannelProviderId => Object.hasOwn(CHANNEL_PROVIDERS, value);

export const channelProvider = (id: ChannelProviderId): ChannelProvider =>
  CHANNEL_PROVIDERS[id];

/**
 * The provider's settings-page deep link for a presence, or null when the
 * provider string is unknown (a DB row must never crash a projection) or the
 * provider has no such page. Takes the raw string so agent projections can
 * pass `channels.provider` without re-narrowing at every call site.
 */
export const presenceSettingsUrlFor = (
  provider: string,
  externalId: string,
): string | null =>
  isChannelProviderId(provider)
    ? (CHANNEL_PROVIDERS[provider].presenceSettingsUrl?.({ externalId }) ??
      null)
    : null;
