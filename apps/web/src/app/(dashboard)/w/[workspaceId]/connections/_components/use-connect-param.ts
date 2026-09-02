"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { getApps } from "@onecli/api/apps/registry";
import type { AppDefinition } from "@onecli/api/apps/types";
import { safeDecode } from "./safe-decode";

interface UseConnectParamOptions {
  loading: boolean;
  connectedProviders: Set<string>;
  configuredProviders: Set<string>;
  envDefaultProviders: Set<string>;
  onConnect: (app: AppDefinition, agentName?: string) => void;
  onConfigure: (app: AppDefinition) => void;
  onRequestApp: (hostname: string, appName?: string) => void;
}

/**
 * Reads `?connect=<provider>` from the URL and triggers the appropriate action:
 * - Has credentials (env defaults available or BYOC configured): `onConnect`
 * - No credentials and not already connected: `onConfigure`
 *
 * When `?source=agent&agent_name=<name>` is also present, the agent name is
 * passed to `onConnect` so the dialog and popup can show agent-specific context.
 *
 * Mirrors the same logic as the manual Connect button click handler.
 * Removes the search param from the URL after handling.
 * Only fires once per mount (guarded by ref).
 */
export const useConnectParam = ({
  loading,
  connectedProviders,
  configuredProviders,
  envDefaultProviders,
  onConnect,
  onConfigure,
  onRequestApp,
}: UseConnectParamOptions) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (loading || handled.current) return;

    const clearActionParams = () => {
      const preserved = new URLSearchParams();
      for (const key of ["q", "category"]) {
        const val = searchParams.get(key);
        if (val) preserved.set(key, val);
      }
      const qs = preserved.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    };

    const requestHost = searchParams.get("request");
    if (requestHost) {
      handled.current = true;
      const appName = safeDecode(searchParams.get("request_name"));
      clearActionParams();
      onRequestApp(requestHost, appName);
      return;
    }

    const provider = searchParams.get("connect");
    if (!provider) return;

    handled.current = true;
    const app = getApps().find((a) => a.id === provider);
    if (!app) {
      clearActionParams();
      return;
    }

    const agentName =
      searchParams.get("source") === "agent"
        ? (safeDecode(searchParams.get("agent_name")) ?? "your agent")
        : undefined;

    clearActionParams();

    const hasCredentials =
      envDefaultProviders.has(app.id) || configuredProviders.has(app.id);

    if (
      app.configurable?.fields &&
      !hasCredentials &&
      !connectedProviders.has(app.id)
    ) {
      onConfigure(app);
    } else {
      onConnect(app, agentName);
    }
  }, [
    loading,
    pathname,
    searchParams,
    connectedProviders,
    configuredProviders,
    envDefaultProviders,
    router,
    onConnect,
    onConfigure,
    onRequestApp,
  ]);
};
