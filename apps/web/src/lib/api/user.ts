import type { AccountDeletionOrgImpact } from "@onecli/api/services/account-deletion-service";
import { apiDelete, apiGet, apiPost } from "./client";

export type { AccountDeletionOrgImpact };

/**
 * The signed-in user's own account (`/v1/user`). The account calls ride the
 * session-only auth: they name no org or workspace, so they work for a user
 * who belongs to no organization at all (no `scopeInit` fallback needed, unlike
 * ssh-keys). Refusals the dialog renders inline: 409 (an owned org still has
 * other members). The personal API key calls are workspace-scoped: the URL's
 * workspace, sent by `apiFetch`.
 */

const base = "/v1/user";

export const deletionImpact = async (): Promise<AccountDeletionOrgImpact[]> => {
  const { organizations } = await apiGet<{
    organizations: AccountDeletionOrgImpact[];
  }>(`${base}/deletion-impact`);
  return organizations;
};

export const remove = () => apiDelete(base);

export interface PersonalApiKey {
  apiKey: string;
}

/** The caller's personal key for the URL's workspace, minted on first read
 * (the mint is audited server-side). */
export const apiKey = () => apiGet<PersonalApiKey>(`${base}/api-key`);

/** Rotate it: the old key stops working at once. Audited server-side. */
export const regenerateApiKey = () =>
  apiPost<PersonalApiKey>(`${base}/api-key/regenerate`, {});
