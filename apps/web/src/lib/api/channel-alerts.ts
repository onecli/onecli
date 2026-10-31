import { apiGet } from "./client";

/** An agent whose messaging connection broke on the provider's side (the
 * app was uninstalled, deleted, or its token revoked). Mirrors the API's
 * `LostChannelConnectionItem`. */
export interface LostChannelConnectionItem {
  /** The presence id. */
  id: string;
  agentId: string;
  agentName: string;
  /** The provider id ("slack"): its name and mark come from the web's
   * channel-provider registry. */
  provider: string;
  /** ISO timestamp. */
  lostAt: string;
}

export const listChannelAlerts = (workspaceId: string) =>
  apiGet<{ items: LostChannelConnectionItem[] }>(
    `/v1/workspaces/${workspaceId}/channel-alerts`,
  ).then((r) => r.items);
