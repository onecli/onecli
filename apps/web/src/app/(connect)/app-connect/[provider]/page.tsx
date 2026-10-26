import { notFound } from "next/navigation";
import { getApp } from "@onecli/api/apps/registry";
import { describeScopes } from "@onecli/api/apps/missing-permissions";
import { checkAppConfigExists } from "@/lib/actions/app-config";
import { ConnectFlow } from "../_components/connect-flow";
import { ConnectLayout } from "../_components/connect-layout";
import { ConnectUpdated } from "../_components/connect-updated";
import { LibraryGranted } from "../_components/library-granted";

interface Props {
  params: Promise<{ provider: string }>;
  searchParams: Promise<{
    status?: string;
    message?: string;
    connectionId?: string;
    /** The freshly-created connection (the callback's success redirect) —
     * distinct from `connectionId`, which means "re-authenticate". */
    connected?: string;
    agent_name?: string;
    /** The agent the connect started from (its page, its chat, its connect
     * link): the API switches the new account on for it. */
    agent_id?: string;
    workspaceId?: string;
    orgId?: string;
    /** Space-joined scopes the user didn't grant (the OAuth callback's
     * success redirect, beside the `connectionId` a retry re-authenticates).
     * Resolved to the app's own permission names, so only scopes the app
     * requests and describes are ever shown. */
    missing?: string;
  }>;
}

export default async function ConnectPage({ params, searchParams }: Props) {
  const { provider } = await params;
  const {
    status,
    message,
    connectionId,
    connected,
    agent_name,
    agent_id,
    workspaceId,
    orgId,
    missing,
  } = await searchParams;

  const app = getApp(provider);
  if (!app) notFound();

  if (status === "updated") {
    return (
      <ConnectLayout
        appName={app.name}
        appIcon={app.icon}
        appDarkIcon={app.darkIcon}
        variant="success"
      >
        <ConnectUpdated appName={app.name} />
      </ConnectLayout>
    );
  }

  // "Install GitHub for skills only": nothing was stored here; the popup
  // hands the signed grant to the Skills page and closes.
  if (provider === "github-app" && status === "library") {
    return (
      <ConnectLayout
        appName={app.name}
        appIcon={app.icon}
        appDarkIcon={app.darkIcon}
        variant="success"
      >
        <LibraryGranted />
      </ConnectLayout>
    );
  }

  const missingScopes = new Set((missing ?? "").split(" "));
  const missingPermissions = describeScopes(provider, (scope) =>
    missingScopes.has(scope),
  );

  // Check if platform defaults are available (server-only env var check)
  let hasEnvDefaults = false;
  if (app.configurable) {
    const defaults = Object.values(app.configurable.envDefaults ?? {});
    hasEnvDefaults =
      defaults.length > 0 && defaults.every((envVar) => !!process.env[envVar]);
  }

  // Check if user has custom AppConfig (org-scoped when the popup carries an
  // orgId — the org connect flow resolves org-level credentials).
  let hasAppConfig = false;
  try {
    hasAppConfig = await checkAppConfigExists(provider, orgId);
  } catch {
    // Auth may not be resolved; treat as false
  }

  // An app may offer an API-key alternate alongside its primary OAuth flow.
  const apiKeyMethod = app.additionalMethods?.find((m) => m.type === "api_key");
  const apiKeyFields =
    apiKeyMethod && apiKeyMethod.type === "api_key"
      ? apiKeyMethod.fields
      : undefined;

  return (
    <ConnectFlow
      app={{
        id: app.id,
        name: app.name,
        icon: app.icon,
        darkIcon: app.darkIcon,
        connectionType: app.connectionMethod.type,
        labelHint: app.labelHint,
        connectNote: app.connectNote,
        setupGuideUrl: app.setupGuideUrl,
        fields:
          app.connectionMethod.type === "api_key" ||
          app.connectionMethod.type === "credentials_import"
            ? app.connectionMethod.fields
            : undefined,
        fileImport:
          app.connectionMethod.type === "credentials_import"
            ? app.connectionMethod.fileImport
            : undefined,
        apiKeyFields,
        accessLevels:
          app.connectionMethod.type === "oauth"
            ? app.connectionMethod.accessLevels
            : undefined,
      }}
      hasDefaults={hasEnvDefaults || hasAppConfig}
      status={status === "success" || status === "error" ? status : undefined}
      errorMessage={message}
      connectionId={connectionId}
      connectedId={connected}
      agentName={agent_name}
      agentId={agent_id}
      workspaceId={workspaceId}
      orgId={orgId}
      missingPermissions={missingPermissions}
    />
  );
}
