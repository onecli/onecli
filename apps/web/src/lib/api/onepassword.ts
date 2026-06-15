// 1Password value picker — browse vaults → items → fields through the gateway.
//
// The gateway proxies these to the Node SDK service; field VALUES never cross
// this boundary, only labels/types. Unlike the typed JSON API client, these hit
// the gateway (different base URL + auth), so they use getGatewayFetchOptions().
import { getGatewayApiUrl } from "@/hooks/use-vault-status";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

export interface OpVault {
  id: string;
  title: string;
}

export interface OpItem {
  id: string;
  title: string;
  category: string;
}

export interface OpField {
  id: string;
  title: string;
  fieldType: string;
  sectionId?: string;
}

export interface OpItemFields {
  fields: OpField[];
  sections: { id: string; title: string }[];
}

export interface OnePasswordConnectionStatus {
  connected: boolean;
}

const base = () => `${getGatewayApiUrl()}/v1/vault/onepassword`;

const gatewayGet = async <T>(path: string): Promise<T> => {
  const { headers, credentials } = await getGatewayFetchOptions();
  const resp = await fetch(`${base()}${path}`, { headers, credentials });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${resp.status})`);
  }
  return resp.json() as Promise<T>;
};

export const getStatus = (): Promise<OnePasswordConnectionStatus> =>
  gatewayGet<OnePasswordConnectionStatus>("/status");

export const listVaults = (): Promise<OpVault[]> =>
  gatewayGet<{ vaults: OpVault[] }>("/vaults").then((r) => r.vaults);

export const listItems = (vaultId: string): Promise<OpItem[]> =>
  gatewayGet<{ items: OpItem[] }>(
    `/vaults/${encodeURIComponent(vaultId)}/items`,
  ).then((r) => r.items);

export const listFields = (
  vaultId: string,
  itemId: string,
): Promise<OpItemFields> =>
  gatewayGet<OpItemFields>(
    `/items/${encodeURIComponent(vaultId)}/${encodeURIComponent(itemId)}/fields`,
  );

/** Build the rename-safe `op://` reference from picked IDs. */
export const buildOpRef = (
  vaultId: string,
  itemId: string,
  fieldId: string,
): string => `op://${vaultId}/${itemId}/${fieldId}`;
