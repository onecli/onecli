import { notFound } from "next/navigation";
import { getApp } from "@/lib/apps/registry";
import { checkAppConfigExists } from "@/lib/actions/app-config";
import { AppDetail } from "../../_components/app-detail";

interface Props {
  params: Promise<{ provider: string }>;
}

export default async function AppDetailPage({ params }: Props) {
  const { provider } = await params;

  const app = getApp(provider);
  if (!app) notFound();

  // Check if platform defaults are available (server-only env var check)
  let hasEnvDefaults = false;
  if (app.configurable) {
    hasEnvDefaults = Object.values(app.configurable.envDefaults).every(
      (envVar) => !!process.env[envVar],
    );
  }

  // Check if user has custom AppConfig
  let hasAppConfig = false;
  try {
    hasAppConfig = await checkAppConfigExists(provider);
  } catch {
    // Auth may not be resolved; treat as false
  }

  const hasCredentials = hasEnvDefaults || hasAppConfig;

  return (
    <AppDetail
      app={{
        id: app.id,
        name: app.name,
        icon: app.icon,
        darkIcon: app.darkIcon,
        description: app.description,
        connectionType: app.connectionMethod.type,
        defaultScopes:
          app.connectionMethod.type === "oauth"
            ? (app.connectionMethod.defaultScopes ?? [])
            : [],
      }}
      hasDefaults={hasCredentials}
      configurable={app.configurable}
      hasEnvDefaults={hasEnvDefaults}
    />
  );
}
