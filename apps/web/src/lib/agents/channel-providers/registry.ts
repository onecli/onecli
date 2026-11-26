import type { ChannelProviderUi } from "../channel-providers";
import { slackProviderUi } from "./slack";

/** Every provider this build ships a UI for — one line per provider. */
export const CHANNEL_PROVIDER_UIS: readonly ChannelProviderUi[] = [
  slackProviderUi,
];

/** Registry lookup — null for a provider id this build does not know (an
 * older web against a newer control plane): the surfaces skip it rather
 * than crash, the same version-skew posture the adapter takes. */
export const channelProviderUi = (id: string): ChannelProviderUi | null =>
  CHANNEL_PROVIDER_UIS.find((p) => p.id === id) ?? null;
