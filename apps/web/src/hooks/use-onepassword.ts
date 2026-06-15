"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";
import { getGatewayApiUrl } from "@/hooks/use-vault-status";

const PROVIDER = "onepassword";

const base = () => `${getGatewayApiUrl()}/v1/vault/${PROVIDER}`;

/** Pair with 1Password by submitting a Service Account token. */
export const useOnePasswordPair = (fetchStatus: () => Promise<void>) => {
  const [pairing, setPairing] = useState(false);

  const pair = useCallback(
    async (token: string): Promise<boolean> => {
      const trimmed = token.trim();
      if (!trimmed) {
        toast.error("Enter a service account token");
        return false;
      }
      setPairing(true);
      try {
        const { headers, credentials } = await getGatewayFetchOptions();
        const resp = await fetch(`${base()}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          credentials,
          body: JSON.stringify({ service_account_token: trimmed }),
        });
        if (resp.ok) {
          toast.success("1Password connected successfully");
          await fetchStatus();
          return true;
        }
        const data = await resp.json().catch(() => ({}));
        toast.error(data.error ?? "Pairing failed");
        return false;
      } catch {
        toast.error("Failed to connect to 1Password");
        return false;
      } finally {
        setPairing(false);
      }
    },
    [fetchStatus],
  );

  return { pair, pairing };
};
