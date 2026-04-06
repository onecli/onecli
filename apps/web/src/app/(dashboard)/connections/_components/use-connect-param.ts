"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apps } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

interface UseConnectParamOptions {
  loading: boolean;
  configuredProviders: Set<string>;
  onConnect: (app: AppDefinition) => void;
  onConfigure: (app: AppDefinition) => void;
}

/**
 * Reads `?connect=<provider>` from the URL and triggers the appropriate action:
 * - If credentials exist (envDefaults or BYOC): calls `onConnect` (show connect dialog)
 * - If no credentials: calls `onConfigure` (show config dialog)
 *
 * Removes the search param from the URL after handling.
 * Only fires once per mount (guarded by ref).
 */
export const useConnectParam = ({
  loading,
  configuredProviders,
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
      !!app.configurable?.envDefaults || configuredProviders.has(app.id);

    if (hasCredentials || !app.configurable?.fields) {
      onConnect(app);
    } else {
      onConfigure(app);
    }
  }, [
    loading,
    searchParams,
    configuredProviders,
    router,
    onConnect,
    onConfigure,
  ]);
};
