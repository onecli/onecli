"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { ConnectLayout } from "./connect-layout";
import { ConnectSuccess } from "./connect-success";

type FlowState = "ready" | "redirecting" | "success" | "error";

interface ConnectFlowProps {
  app: {
    id: string;
    name: string;
    icon: string;
    darkIcon?: string;
    connectionType: string;
  };
  hasDefaults: boolean;
  status?: "success" | "error";
  errorMessage?: string;
}

export const ConnectFlow = ({
  app,
  hasDefaults,
  status,
  errorMessage,
}: ConnectFlowProps) => {
  const [state, setState] = useState<FlowState>(
    status === "success" ? "success" : status === "error" ? "error" : "ready",
  );
  const [error, setError] = useState(errorMessage ?? "");
  const [countdown, setCountdown] = useState(3);
  const redirectedRef = useRef(false);

  const doRedirect = useCallback(() => {
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    setState("redirecting");
    window.location.href = `/api/connections/${app.id}/authorize`;
  }, [app.id]);

  // Countdown timer for auto-redirect
  useEffect(() => {
    if (state !== "ready" || !hasDefaults) return;
    if (app.connectionType !== "oauth") return;

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
  }, [state, hasDefaults, app.connectionType, doRedirect]);

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
        />
      </ConnectLayout>
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
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed max-w-[280px]">
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
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              {app.name} needs OAuth credentials before connecting.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              try {
                window.opener?.postMessage(
                  {
                    type: "app-configure",
                    provider: app.id,
                    url: `/connections/apps/${app.id}`,
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
        </div>
      </ConnectLayout>
    );
  }

  // Ready / redirecting state
  const isRedirecting = state === "redirecting";
  const showCountdown = state === "ready" && hasDefaults && countdown > 0;
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
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {isRedirecting
              ? `Redirecting to ${app.name}...`
              : `Taking you to ${app.name}`}
          </p>
          {isRedirecting ? null : (
            <p className="text-sm text-muted-foreground mt-0.5">
              Please authenticate to continue
            </p>
          )}
        </div>

        {isRedirecting ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>Opening {app.name}...</span>
          </div>
        ) : (
          <div className="w-full space-y-3">
            <Button className="w-full" onClick={doRedirect}>
              Connect to {app.name}
            </Button>
            {showCountdown && (
              <p className="text-center text-xs text-muted-foreground/60">
                Auto-connecting in {countdown}s
              </p>
            )}
          </div>
        )}
      </div>
    </ConnectLayout>
  );
};
