import { channelProviderUi } from "./channel-providers/registry";

/** "slack" → "Slack": the registry's name when the build knows the provider,
 * else a title-cased id (an older web against a newer control plane). */
export const providerLabel = (provider: string) =>
  channelProviderUi(provider)?.name ??
  provider.charAt(0).toUpperCase() + provider.slice(1);

export const providerAppIcon = (
  provider: string,
): { icon: string; darkIcon?: string; name: string } | null => {
  const ui = channelProviderUi(provider);
  return ui ? { icon: ui.iconSrc, name: ui.name } : null;
};
