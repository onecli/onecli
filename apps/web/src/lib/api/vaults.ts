import { apiGet } from "./client";

export interface VaultConnection {
  id: string;
  provider: string;
  status: string;
  name: string | null;
  lastConnectedAt: string | null;
}

export const list = () => apiGet<VaultConnection[]>("/v1/vaults");
