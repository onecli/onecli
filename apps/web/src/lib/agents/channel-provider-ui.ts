import { slack } from "@onecli/api/apps/slack";

/** "slack" → "Slack". One provider today; capitalizing beats a registry of
 * one entry, and a second provider gets a real label table then. */
export const providerLabel = (provider: string) =>
  provider.charAt(0).toUpperCase() + provider.slice(1);

/**
 * The channel provider's brand mark, sourced from the app registry (the
 * `slack-integration-card` import precedent — the app modules are leaf files
 * that bundle cleanly client-side). A provider without an entry renders a
 * neutral glyph instead; adding one here is the whole job.
 */
const PROVIDER_APPS: Record<
  string,
  { icon: string; darkIcon?: string; name: string }
> = {
  slack: { icon: slack.icon, darkIcon: slack.darkIcon, name: slack.name },
};

export const providerAppIcon = (provider: string) =>
  PROVIDER_APPS[provider] ?? null;
