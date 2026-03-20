"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { GATEWAY_URL, getGatewayFetchOptions } from "@/lib/gateway-auth";

export interface VaultStatus<T = unknown> {
  connected: boolean;
  name: string | null;
  status_data: T | null;
}

export interface BitwardenStatusData {
  fingerprint: string;
  last_error: string | null;
}

export const useVaultStatus = <T = unknown>(provider: string = "bitwarden") => {
  const [status, setStatus] = useState<VaultStatus<T> | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch(
        `${GATEWAY_URL}/api/vault/${provider}/status`,
        getGatewayFetchOptions(),
      );
      if (resp.ok) {
        setStatus(await resp.json());
      }
    } catch {
      // Gateway unreachable
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const isPaired = status?.connected || status?.status_data != null;
  const isReady = status?.connected ?? false;

  return { status, loading, isPaired, isReady, fetchStatus };
};

export const useVaultPair = (
  fetchStatus: () => Promise<void>,
  provider: string = "bitwarden",
) => {
  const [pairing, setPairing] = useState(false);

  const pair = useCallback(
    async (pskHex: string, fingerprintHex: string): Promise<boolean> => {
      if (pskHex.length !== 64 || fingerprintHex.length !== 64) {
        toast.error("PSK and fingerprint must each be 64 hex characters");
        return false;
      }

      setPairing(true);
      try {
        const resp = await fetch(`${GATEWAY_URL}/api/vault/${provider}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            psk_hex: pskHex,
            fingerprint_hex: fingerprintHex,
          }),
          ...getGatewayFetchOptions(),
        });

        if (resp.ok) {
          toast.success("Vault connected successfully");
          await fetchStatus();
          return true;
        } else {
          const data = await resp.json();
          toast.error(data.error ?? "Pairing failed");
          return false;
        }
      } catch {
        toast.error("Failed to connect to vault");
        return false;
      } finally {
        setPairing(false);
      }
    },
    [fetchStatus, provider],
  );

  return { pair, pairing };
};

export const useVaultDisconnect = (
  fetchStatus: () => Promise<void>,
  provider: string = "bitwarden",
) => {
  const [disconnecting, setDisconnecting] = useState(false);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const resp = await fetch(`${GATEWAY_URL}/api/vault/${provider}/pair`, {
        method: "DELETE",
        ...getGatewayFetchOptions(),
      });
      if (resp.ok) {
        toast.success("Vault disconnected");
        await fetchStatus();
      } else {
        toast.error("Failed to disconnect");
      }
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }, [fetchStatus, provider]);

  return { disconnect, disconnecting };
};
