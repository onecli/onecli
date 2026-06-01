import { getApp } from "./registry";

interface ProviderIcon {
  name: string;
  icon: string;
  darkIcon?: string;
}

const HOST_ICON_MAP: Record<string, ProviderIcon> = {
  "api.anthropic.com": {
    name: "Anthropic",
    icon: "/icons/anthropic.svg",
    darkIcon: "/icons/anthropic-light.svg",
  },
  anthropic: {
    name: "Anthropic",
    icon: "/icons/anthropic.svg",
    darkIcon: "/icons/anthropic-light.svg",
  },
  "api.openai.com": {
    name: "OpenAI",
    icon: "/icons/openai.svg",
    darkIcon: "/icons/openai-light.svg",
  },
  openai: {
    name: "OpenAI",
    icon: "/icons/openai.svg",
    darkIcon: "/icons/openai-light.svg",
  },
};

const DOMAIN_ICON_MAP: Record<string, ProviderIcon> = {
  "anthropic.com": {
    name: "Anthropic",
    icon: "/icons/anthropic.svg",
    darkIcon: "/icons/anthropic-light.svg",
  },
  "openai.com": {
    name: "OpenAI",
    icon: "/icons/openai.svg",
    darkIcon: "/icons/openai-light.svg",
  },
};

export const getProviderIcon = (provider: string): ProviderIcon | undefined => {
  const app = getApp(provider);
  if (app) {
    return { name: app.name, icon: app.icon, darkIcon: app.darkIcon };
  }

  if (HOST_ICON_MAP[provider]) {
    return HOST_ICON_MAP[provider];
  }

  for (const [domain, icon] of Object.entries(DOMAIN_ICON_MAP)) {
    if (provider.endsWith(`.${domain}`) || provider === domain) {
      return icon;
    }
  }

  return undefined;
};
