"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apps } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

interface UseConnectParamOptions {
  loading: boolean;
  connectedProviders: Set<string>;
  configuredProviders: Set<string>;
  envDefaultProviders: Set<string>;
  onConnect: (app: AppDefinition) => void;
  onConfigure: (app: AppDefinition) => void;
}

/**
 * Reads `?connect=<provider>` from the URL and triggers the appropriate action:
 * - Has credentials (env defaults available or BYOC configured): `onConnect`
 * - No credentials and not already connected: `onConfigure`
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
}: UseConnectParamOptions) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (loading || handled.current) return;
    const provider = searchParams.get("connect");
    if (!provider) return;

    handled.current = true;
    const app = apps.find((a) => a.id === provider);
    if (!app) {
      router.replace("/connections");
      return;
    }

    router.replace("/connections");

    const hasCredentials =
      envDefaultProviders.has(app.id) || configuredProviders.has(app.id);

    if (
      app.configurable?.fields &&
      !hasCredentials &&
      !connectedProviders.has(app.id)
    ) {
      onConfigure(app);
    } else {
      onConnect(app);
    }
  }, [
    loading,
    searchParams,
    connectedProviders,
    configuredProviders,
    envDefaultProviders,
    router,
    onConnect,
    onConfigure,
  ]);
};
