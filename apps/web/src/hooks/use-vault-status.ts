"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export interface VaultStatus {
  connection: {
    fingerprint: string;
    name: string | null;
    status: string;
    lastConnectedAt: string | null;
    createdAt: string;
  } | null;
  gateway: {
    paired: boolean;
    ready: boolean;
    fingerprint: string;
    remote_fingerprint: string | null;
    relay_url: string;
  } | null;
}

export const useVaultStatus = () => {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch("/api/vault/status");
      if (resp.ok) {
        setStatus(await resp.json());
      }
    } catch {
      // Status endpoint unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const isPaired = status?.connection != null || status?.gateway?.paired;
  const isReady = status?.gateway?.ready ?? false;

  return { status, loading, isPaired, isReady, fetchStatus };
};

export const useVaultPair = (fetchStatus: () => Promise<void>) => {
  const [pairing, setPairing] = useState(false);

  const pair = useCallback(
    async (pskHex: string, fingerprintHex: string): Promise<boolean> => {
      if (pskHex.length !== 64 || fingerprintHex.length !== 64) {
        toast.error("PSK and fingerprint must each be 64 hex characters");
        return false;
      }

      setPairing(true);
      try {
        const resp = await fetch("/api/vault/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            psk_hex: pskHex,
            fingerprint_hex: fingerprintHex,
          }),
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
    [fetchStatus],
  );

  return { pair, pairing };
};

export const useVaultDisconnect = (fetchStatus: () => Promise<void>) => {
  const [disconnecting, setDisconnecting] = useState(false);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const resp = await fetch("/api/vault/disconnect", { method: "DELETE" });
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
  }, [fetchStatus]);

  return { disconnect, disconnecting };
};
