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
  "api.openai.com": {
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
  return HOST_ICON_MAP[provider];
};
