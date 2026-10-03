import type { AccountDeletionOrgImpact } from "@onecli/api/services/account-deletion-service";
import { apiDelete, apiGet } from "./client";

export type { AccountDeletionOrgImpact };

/**
 * The signed-in user's own account (`/v1/user`). Both calls ride the
 * session-only auth: they name no org or workspace, so they work for a user
 * who belongs to no organization at all (no `scopeInit` fallback needed, unlike
 * ssh-keys). Refusals the dialog renders inline: 409 (an owned org still has
 * other members).
 */

const base = "/v1/user";

export const deletionImpact = async (): Promise<AccountDeletionOrgImpact[]> => {
  const { organizations } = await apiGet<{
    organizations: AccountDeletionOrgImpact[];
  }>(`${base}/deletion-impact`);
  return organizations;
};

export const remove = () => apiDelete(base);
