import { notFound } from "next/navigation";
import { getApp } from "@/lib/apps/registry";
import { checkAppConfigExists } from "@/lib/actions/app-config";
import { ConnectFlow } from "../_components/connect-flow";

interface Props {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{ status?: string; message?: string }>;
}

export default async function ConnectPage({ params, searchParams }: Props) {
  const { provider } = await params;
  const { status, message } = await searchParams;

  const app = getApp(provider);
  if (!app || !app.available) notFound();

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

  return (
    <ConnectFlow
      app={{
        id: app.id,
        name: app.name,
        icon: app.icon,
        darkIcon: app.darkIcon,
        connectionType: app.connectionMethod.type,
      }}
      hasDefaults={hasEnvDefaults || hasAppConfig}
      status={status as "success" | "error" | undefined}
      errorMessage={message}
    />
  );
}
