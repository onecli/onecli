"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";
import { getGatewayApiUrl } from "@/hooks/use-vault-status";
import { getStatus, listFields, listRecords } from "@/lib/api/keepersecurity";
import { queryKeys } from "@/lib/api/keys";

const PROVIDER = "keepersecurity";

// Record contents change rarely within a dialog session; cache briefly so the
// picker feels instant and doesn't re-hit Keeper on every reopen.
const STALE_TIME = 60_000;

/**
 * How the user is connecting, chosen explicitly in the form.
 */
export type KeeperSecurityPairMethod =
  | "one_time_token"
  | "base64_config"
  | "json_config";

const EMPTY_INPUT_MESSAGE: Record<KeeperSecurityPairMethod, string> = {
  one_time_token: "Enter a one-time access token",
  base64_config: "Enter a base64 configuration",
  json_config: "Enter a JSON configuration",
};

/** A JSON config must at least parse as an object; the server checks the keys. */
const isJsonObject = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
};

/**
 * The `pair` body for a method. A token is bound server-side; a config carries
 * the format the user chose (`ksm_config_format`), so the server decodes it
 * as told and never guesses from the text.
 */
const pairBody = (method: KeeperSecurityPairMethod, value: string) => {
  switch (method) {
    case "one_time_token":
      return { one_time_token: value };
    case "base64_config":
      return { ksm_config: value, ksm_config_format: "base64" };
    case "json_config":
      return { ksm_config: value, ksm_config_format: "json" };
  }
};

/**
 * Pair with Keeper Secrets Manager. Accepts either a one-time access token
 * (bound to a reusable config server-side; the token itself is never stored)
 * or an existing KSM config (base64 or JSON), as chosen by `method`.
 */
export const useKeeperSecurityPair = (fetchStatus: () => Promise<void>) => {
  const [pairing, setPairing] = useState(false);

  const pair = useCallback(
    async (
      method: KeeperSecurityPairMethod,
      input: string,
    ): Promise<boolean> => {
      const trimmed = input.trim();
      if (!trimmed) {
        toast.error(EMPTY_INPUT_MESSAGE[method]);
        return false;
      }
      if (method === "json_config" && !isJsonObject(trimmed)) {
        toast.error("The configuration is not a valid JSON object");
        return false;
      }
      const body = pairBody(method, trimmed);

      setPairing(true);
      try {
        const { headers, credentials } = await getGatewayFetchOptions();
        const resp = await fetch(
          `${getGatewayApiUrl()}/v1/vault/${PROVIDER}/pair`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            credentials,
            body: JSON.stringify(body),
          },
        );
        if (resp.ok) {
          toast.success("Keeper connected successfully");
          await fetchStatus();
          return true;
        }
        const data = await resp.json().catch(() => ({}));
        toast.error(data.error ?? "Pairing failed");
        return false;
      } catch {
        toast.error("Failed to connect to Keeper");
        return false;
      } finally {
        setPairing(false);
      }
    },
    [fetchStatus],
  );

  return { pair, pairing };
};

/**
 * Whether Keeper is connected for this workspace. Deduped across every mounted
 * SecretDialog (one query key), and gated by `enabled` so closed dialogs don't
 * poll the gateway.
 */
export const useKeeperSecurityReady = (enabled: boolean) => {
  const query = useQuery({
    queryKey: queryKeys.keepersecurity.status(),
    queryFn: getStatus,
    enabled,
    staleTime: STALE_TIME,
  });
  return { isReady: query.data?.connected ?? false, ...query };
};

/** Records shared with the KSM application. */
export const useKeeperSecurityRecords = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.keepersecurity.records(),
    queryFn: listRecords,
    enabled,
    staleTime: STALE_TIME,
  });

/** A record's referenceable fields. */
export const useKeeperSecurityFields = (recordUid: string | null) =>
  useQuery({
    queryKey: queryKeys.keepersecurity.fields(recordUid ?? ""),
    queryFn: () => listFields(recordUid as string),
    enabled: !!recordUid,
    staleTime: STALE_TIME,
  });
