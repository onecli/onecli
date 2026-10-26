"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ConnectNote, OAuthAccessLevels } from "@onecli/api/apps/types";
import { Button } from "@onecli/ui/components/button";
import { IS_CLOUD } from "@/lib/env";
import { API_ORIGIN, getAuthToken, getWorkspaceId } from "@/lib/api-fetch";
import { SetupGuideLink } from "@/lib/components/setup-guide-link";
import { AccessLevelSelect } from "./access-level-select";
import { ConnectLayout } from "./connect-layout";
import { ConnectSuccess } from "./connect-success";
import { CredentialsFlow } from "./credentials-flow";
import { OrDivider } from "./or-divider";
import type { MissingPermission } from "@onecli/api/apps/missing-permissions";

type FlowState = "ready" | "redirecting" | "success" | "error";

interface ConnectFlowProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    connectionType: string;
    labelHint?: string;
    connectNote?: ConnectNote;
    setupGuideUrl?: string;
    fields?: {
      name: string;
      label: string;
      description?: string;
      placeholder: string;
      secret?: boolean;
      optional?: boolean;
      group?: string;
      helpUrl?: string;
      helpLabel?: string;
      options?: { value: string; label: string }[];
      defaultValue?: string;
    }[];
    fileImport?: {
      label: string;
      accept: string;
      keyMap: Record<string, string>;
    };
    apiKeyFields?: {
      name: string;
      label: string;
      description?: string;
      placeholder: string;
      secret?: boolean;
      optional?: boolean;
      group?: string;
      helpUrl?: string;
      helpLabel?: string;
      options?: { value: string; label: string }[];
      defaultValue?: string;
    }[];
    accessLevels?: OAuthAccessLevels;
  };
  hasDefaults: boolean;
  status?: "success" | "error";
  errorMessage?: string;
  connectionId?: string;
  /** The freshly-CREATED connection (the OAuth callback's `connected` param) —
   * handed to the parent window on success so it can offer agent access.
   * Distinct from `connectionId`, which means "re-authenticate this existing
   * connection". */
  connectedId?: string;
  agentName?: string;
  /** The agent the connect started from: the created (or re-added) account
   * is switched on for it. Rides /authorize (OAuth) or the connect body. */
  agentId?: string;
  preContent?: ReactNode;
  workspaceId?: string;
  orgId?: string;
  /** Requested permissions the provider didn't grant (the user unticked them
   * on the consent screen). The success screen warns and offers a retry,
   * which re-authenticates `connectionId` (so it can't create a second). */
  missingPermissions?: MissingPermission[];
}

export const ConnectFlow = ({
  app,
  hasDefaults,
  status,
  errorMessage,
  connectionId,
  connectedId,
  agentName,
  agentId,
  preContent,
  workspaceId: explicitWorkspaceId,
  orgId,
  missingPermissions = [],
}: ConnectFlowProps) => {
  const [state, setState] = useState<FlowState>(
    status === "success" ? "success" : status === "error" ? "error" : "ready",
  );
  const [error, setError] = useState(errorMessage ?? "");
  const [countdown, setCountdown] = useState(3);
  const redirectedRef = useRef(false);
  const [mode, setMode] = useState<"oauth" | "apikey">("oauth");
  // The credentials flow reports the connection it created client-side (the
  // OAuth path delivers the same via the `connected` redirect param).
  const [createdConnectionId, setCreatedConnectionId] = useState<
    string | undefined
  >(undefined);
  const hasApiKeyAlternate = !!app.apiKeyFields?.length;
  const [accessLevel, setAccessLevel] = useState(
    app.accessLevels?.defaultValue,
  );
  // Whether the ready screen counts down and redirects on its own. Off when
  // the user has something to decide or read first: an API-key alternate to
  // pick instead of OAuth, an access level to choose, or a connect note (e.g.
  // an admin-only prerequisite) that must not race a 3-second redirect. The
  // timer and the "Auto-connecting" label both key off this, so neither can
  // show without the other.
  const autoRedirects =
    hasDefaults &&
    app.connectionType === "oauth" &&
    !hasApiKeyAlternate &&
    !app.accessLevels &&
    !app.connectNote;

  const doRedirect = useCallback(async () => {
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    setState("redirecting");
    const params = new URLSearchParams();
    if (connectionId) params.set("connectionId", connectionId);
    if (agentName) params.set("agent_name", agentName);
    if (agentId) params.set("agent_id", agentId);
    if (accessLevel) params.set("access_level", accessLevel);

    const token = await getAuthToken();
    if (token) params.set("_token", token);
    const workspaceId = explicitWorkspaceId || getWorkspaceId();
    if (workspaceId) params.set("_workspace", workspaceId);
    if (orgId) params.set("_org", orgId);

    const qs = params.toString();
    const authorizeUrl = `${API_ORIGIN}/v1/apps/${app.id}/authorize${qs ? `?${qs}` : ""}`;
    window.location.href = authorizeUrl;
  }, [
    app.id,
    connectionId,
    agentName,
    agentId,
    accessLevel,
    explicitWorkspaceId,
    orgId,
  ]);

  // Countdown timer for auto-redirect
  useEffect(() => {
    if (state !== "ready" || !autoRedirects) return;

    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          doRedirect();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [state, autoRedirects, doRedirect]);

  if (state === "success") {
    return (
      <ConnectLayout
        appName={app.name}
        appIcon={app.icon}
        appDarkIcon={app.darkIcon}
        variant="success"
      >
        <ConnectSuccess
          appName={app.name}
          appIcon={app.icon}
          provider={app.id}
          agentName={agentName}
          connectedId={connectedId ?? createdConnectionId}
          missingPermissions={missingPermissions}
          onRetry={() => {
            redirectedRef.current = false;
            void doRedirect();
          }}
        />
      </ConnectLayout>
    );
  }

  // API key alternate for an OAuth-primary app (e.g. Attio) when the user
  // chose "Use an API key instead".
  if (mode === "apikey" && app.apiKeyFields?.length && state !== "error") {
    return (
      <CredentialsFlow
        app={{ ...app, connectionType: "api_key" }}
        fields={app.apiKeyFields}
        method="api_key"
        connectionId={connectionId}
        preContent={preContent}
        workspaceId={explicitWorkspaceId}
        orgId={orgId}
        agentId={agentId}
        onBack={() => setMode("oauth")}
        onSuccess={(connection) => {
          setCreatedConnectionId(connection?.id);
          setState("success");
        }}
        onError={(msg) => {
          setError(msg);
          setState("error");
        }}
      />
    );
  }

  // Credentials flow — render form instead of OAuth redirect
  if (
    (app.connectionType === "api_key" ||
      app.connectionType === "credentials_import") &&
    app.fields &&
    state !== "error"
  ) {
    return (
      <CredentialsFlow
        app={app}
        fields={app.fields}
        fileImport={app.fileImport}
        connectionId={connectionId}
        preContent={preContent}
        workspaceId={explicitWorkspaceId}
        orgId={orgId}
        agentId={agentId}
        onSuccess={(connection) => {
          setCreatedConnectionId(connection?.id);
          setState("success");
        }}
        onError={(msg) => {
          setError(msg);
          setState("error");
        }}
      />
    );
  }

  if (state === "error") {
    return (
      <ConnectLayout
        appName={app.name}
        appIcon={app.icon}
        appDarkIcon={app.darkIcon}
        variant="error"
      >
        <div className="flex flex-col items-center gap-5 py-4">
          <div className="text-center">
            <p className="text-sm font-medium">Connection failed</p>
            <p className="mt-1.5 max-w-70 text-xs leading-relaxed text-muted-foreground">
              {error || "An unexpected error occurred. Please try again."}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setState("ready");
            }}
          >
            Try again
          </Button>
        </div>
      </ConnectLayout>
    );
  }

  if (!hasDefaults) {
    return (
      <ConnectLayout
        appName={app.name}
        appIcon={app.icon}
        appDarkIcon={app.darkIcon}
      >
        <div className="flex flex-col items-center gap-5 py-4">
          <div className="text-center">
            <p className="text-sm font-medium">Configuration required</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {app.name} needs OAuth credentials before connecting.
            </p>
          </div>
          <SetupGuideLink appName={app.name} url={app.setupGuideUrl} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              try {
                window.opener?.postMessage(
                  {
                    type: "app-configure",
                    provider: app.id,
                  },
                  window.location.origin,
                );
              } catch {
                // Cross-origin or no opener
              }
              window.close();
            }}
          >
            Configure credentials
          </Button>
          {hasApiKeyAlternate && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMode("apikey")}
            >
              Use an API key instead
            </Button>
          )}
          {!IS_CLOUD && (
            <>
              <OrDivider label="or" className="pt-1" />
              <p className="text-muted-foreground text-xs">
                Skip setup with{" "}
                <a
                  href="https://app.onecli.sh"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline decoration-foreground/20 underline-offset-2 transition-colors hover:decoration-foreground/60"
                >
                  OneCLI Cloud
                </a>
              </p>
            </>
          )}
        </div>
      </ConnectLayout>
    );
  }

  // Ready / redirecting state
  const isRedirecting = state === "redirecting";
  const showCountdown = state === "ready" && autoRedirects && countdown > 0;
  const totalSeconds = 3;
  const progress = showCountdown
    ? Math.round(((totalSeconds - countdown) / totalSeconds) * 100)
    : isRedirecting
      ? 100
      : null;

  return (
    <ConnectLayout
      appName={app.name}
      appIcon={app.icon}
      appDarkIcon={app.darkIcon}
      progress={progress}
    >
      <div className="flex flex-col items-center gap-6 py-4">
        {isRedirecting ? null : (
          <SetupGuideLink appName={app.name} url={app.setupGuideUrl} />
        )}
        {/* An app with an access-level choice shows that choice instead of
            the generic "Taking you to" text. */}
        {isRedirecting || !app.accessLevels ? (
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              {isRedirecting
                ? `Redirecting to ${app.name}...`
                : `Taking you to ${app.name}`}
            </p>
            {isRedirecting ? null : (
              <p className="text-sm text-muted-foreground mt-0.5">
                {connectionId
                  ? "Re-authenticate to refresh your credentials"
                  : "Please authenticate to continue"}
              </p>
            )}
          </div>
        ) : null}

        {isRedirecting ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Opening {app.name}...</span>
          </div>
        ) : (
          <div className="w-full space-y-3">
            {app.connectNote && (
              <div
                className="space-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground"
                data-testid="connect-note"
              >
                <p>{app.connectNote.text}</p>
                {app.connectNote.fallback && <p>{app.connectNote.fallback}</p>}
                {app.connectNote.link && (
                  <a
                    href={app.connectNote.link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block underline underline-offset-2 hover:text-foreground"
                  >
                    {app.connectNote.link.label}
                  </a>
                )}
              </div>
            )}
            {app.accessLevels && accessLevel && (
              <AccessLevelSelect
                levels={app.accessLevels}
                value={accessLevel}
                onChange={setAccessLevel}
              />
            )}
            <Button className="w-full" onClick={doRedirect}>
              Connect to {app.name}
            </Button>
            {showCountdown && (
              <p className="text-center text-xs text-muted-foreground/60">
                Auto-connecting in {countdown}s
              </p>
            )}
            {hasApiKeyAlternate && (
              <>
                <OrDivider label="or" />
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setMode("apikey")}
                >
                  Use an API key instead
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </ConnectLayout>
  );
};
