"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getGatewayApiUrl } from "@/lib/gateway-url";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

export { getGatewayApiUrl } from "@/lib/gateway-url";

export interface VaultStatus<T = unknown> {
  connected: boolean;
  name: string | null;
  status_data: T | null;
}

export interface BitwardenStatusData {
  fingerprint: string;
  last_error: string | null;
}

export interface OnePasswordStatusData {
  last_error: string | null;
}

/**
 * Why a paired Keeper connection can't serve credentials:
 * - `connection_failed`: OneCLI can't use the connection, whatever the cause
 *   (access expired or revoked, device removed, Keeper unreachable, the stored
 *   configuration unreadable); the detail is in `last_error`.
 * - `no_records`: Keeper accepts it but nothing is shared with it any more.
 */
export type KeeperSecurityStatusReason = "connection_failed" | "no_records";

export interface KeeperSecurityStatusData {
  last_error: string | null;
  /** Absent from gateways that predate it. */
  reason?: KeeperSecurityStatusReason | null;
  /** Records shared with the application, from the last successful check. */
  record_count?: number | null;
  /** When the application's access expires (ISO 8601), if Keeper set a limit. */
  expires_on?: string | null;
  warnings?: string[];
  /** The last reference an agent request could not resolve. */
  resolve_error?: { ref: string; message: string } | null;
}

/** How often an auto-refreshing status re-checks while the page is visible. */
export const STATUS_REFRESH_INTERVAL_MS = 60_000;

interface UseVaultStatusOptions {
  /**
   * Re-check when the tab regains focus and every
   * {@link STATUS_REFRESH_INTERVAL_MS} while it is visible, so a connection
   * revoked on the vault's side shows up without a reload.
   */
  autoRefresh?: boolean;
}

export const useVaultStatus = <T = unknown>(
  provider: string = "bitwarden",
  { autoRefresh = false }: UseVaultStatusOptions = {},
) => {
  const [status, setStatus] = useState<VaultStatus<T> | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const { headers, credentials } = await getGatewayFetchOptions();
      const resp = await fetch(
        `${getGatewayApiUrl()}/v1/vault/${provider}/status`,
        {
          headers,
          credentials,
        },
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

  useEffect(() => {
    if (!autoRefresh) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void fetchStatus();
    };
    const interval = setInterval(refreshIfVisible, STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [autoRefresh, fetchStatus]);

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
        const { headers, credentials } = await getGatewayFetchOptions();
        const resp = await fetch(
          `${getGatewayApiUrl()}/v1/vault/${provider}/pair`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            credentials,
            body: JSON.stringify({
              psk_hex: pskHex,
              fingerprint_hex: fingerprintHex,
            }),
          },
        );

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
      const { headers, credentials } = await getGatewayFetchOptions();
      const resp = await fetch(
        `${getGatewayApiUrl()}/v1/vault/${provider}/pair`,
        {
          method: "DELETE",
          headers,
          credentials,
        },
      );
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
