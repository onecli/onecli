// Keeper Secrets Manager — connection status and the value picker (browse
// records → fields), both read from the gateway.
//
// The gateway proxies the picker to the Node SDK service; field VALUES never
// cross this boundary, only titles/labels and the `keeper://` reference that
// resolves each field. These hit the gateway (different base URL + auth), so
// they use getGatewayFetchOptions().
import { getGatewayApiUrl } from "@/hooks/use-vault-status";
import { getGatewayFetchOptions } from "@/lib/gateway-auth";

export interface KeeperSecurityConnectionStatus {
  connected: boolean;
}

export interface KeeperSecurityRecord {
  uid: string;
  title: string;
  /** Keeper record type, e.g. `login`, `databaseCredentials`. */
  type: string;
  /** Folder path (`Shared / Team`), when the record sits in a shared folder. */
  folder?: string;
}

export interface KeeperSecurityField {
  /** Full `keeper://` reference, computed server-side to be unambiguous. */
  ref: string;
  label: string;
  fieldType: string;
}

/** Readable labels saved alongside a picked reference (which holds only UIDs). */
export interface KeeperSecurityDisplay {
  record: string;
  field: string;
  folder?: string;
}

const base = () => `${getGatewayApiUrl()}/v1/vault/keepersecurity`;

const gatewayGet = async <T>(path: string): Promise<T> => {
  const { headers, credentials } = await getGatewayFetchOptions();
  const resp = await fetch(`${base()}${path}`, { headers, credentials });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(gatewayErrorMessage(path, resp.status, data.error));
  }
  return resp.json() as Promise<T>;
};

/**
 * The gateway's own message when it sent one; otherwise say which Keeper call
 * failed and how. A body with no message means the request never reached the
 * Keeper handler (most often a gateway built before these routes existed), so
 * a bare "Request failed (400)" would point nowhere.
 */
export const gatewayErrorMessage = (
  path: string,
  status: number,
  error: unknown,
): string => {
  if (typeof error === "string" && error.trim()) return error;
  const what = path.startsWith("/records/")
    ? "this record’s fields"
    : path === "/records"
      ? "Keeper records"
      : "Keeper status";
  return status === 401 || status === 403
    ? `Couldn’t load ${what}: your session has expired. Reload the page and sign in again.`
    : `Couldn’t load ${what}: the gateway answered ${status} without details. If OneCLI was just updated, restart the gateway.`;
};

export const getStatus = (): Promise<KeeperSecurityConnectionStatus> =>
  gatewayGet<KeeperSecurityConnectionStatus>("/status");

export const listRecords = (): Promise<KeeperSecurityRecord[]> =>
  gatewayGet<{ records: KeeperSecurityRecord[] }>("/records").then(
    (r) => r.records,
  );

export const listFields = (recordUid: string): Promise<KeeperSecurityField[]> =>
  gatewayGet<{ fields: KeeperSecurityField[] }>(
    `/records/${encodeURIComponent(recordUid)}/fields`,
  ).then((r) => r.fields);
