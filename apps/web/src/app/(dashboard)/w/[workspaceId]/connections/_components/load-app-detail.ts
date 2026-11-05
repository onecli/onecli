import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { getApp } from "@onecli/api/apps/registry";
import type { AppDetail } from "./app-detail";

type AppDetailData = Pick<
  ComponentProps<typeof AppDetail>,
  "app" | "configurable" | "hasEnvDefaults" | "hasAppConfig"
>;

/**
 * Server-side props for an app's detail page, shared by the workspace and
 * organization pages: the catalog entry (404 when the provider is unknown),
 * whether every platform env default is set, and whether the page's scope
 * already has its own app config.
 */
export const loadAppDetail = async (
  provider: string,
  checkAppConfigExists: (provider: string) => Promise<boolean>,
): Promise<AppDetailData> => {
  const app = getApp(provider);
  if (!app) notFound();

  let hasEnvDefaults = false;
  if (app.configurable) {
    const defaults = Object.values(app.configurable.envDefaults ?? {});
    hasEnvDefaults =
      defaults.length > 0 && defaults.every((envVar) => !!process.env[envVar]);
  }

  let hasAppConfig = false;
  try {
    hasAppConfig = await checkAppConfigExists(provider);
  } catch {
    // Auth may not be resolved; treat as defaults
  }

  return {
    app: {
      id: app.id,
      name: app.name,
      icon: app.icon,
      darkIcon: app.darkIcon,
      description: app.description,
      connectionType: app.connectionMethod.type,
      hasApiKeyAlternate: (app.additionalMethods ?? []).some(
        (m) => m.type === "api_key",
      ),
      blocklist: app.blocklist,
      setupGuideUrl: app.setupGuideUrl,
    },
    configurable: app.configurable,
    hasEnvDefaults,
    hasAppConfig,
  };
};
