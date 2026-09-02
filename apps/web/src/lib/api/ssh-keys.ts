import { getOrganizationId } from "@/lib/api-fetch";
import { readDefaultOrgCookie } from "@/lib/navigation";
import { apiDelete, apiGet, apiPost } from "./client";
import type { SshKey } from "./types";

/**
 * Registered SSH public keys — account-level (`/v1/user/ssh-keys`), consumed
 * from BOTH the /account settings page and the agent SSH page. Refusals are
 * states the callers render inline: 409 (duplicate key, registry cap), 422
 * (not an ed25519 key).
 */

const base = "/v1/user/ssh-keys";

// On /account/* routes the URL names no org, and cloud session auth resolves
// its organization from the X-Organization-Id header — without it every call
// 401s. Fall back to the default-org cookie (the Get Started precedent in
// workspaces.ts); the server re-validates membership. On /org/* URLs the
// ambient URL-derived header wins (this returns undefined); on /w/* URLs the
// cookie header rides along harmlessly — session auth resolves the org from
// the workspace first and never reads it.
const scopeInit = (): RequestInit | undefined => {
  if (getOrganizationId()) return undefined;
  const organizationId = readDefaultOrgCookie();
  return organizationId
    ? { headers: { "X-Organization-Id": organizationId } }
    : undefined;
};

export const list = async (): Promise<SshKey[]> => {
  const { sshKeys } = await apiGet<{ sshKeys: SshKey[] }>(base, scopeInit());
  return sshKeys;
};

export const create = (input: { name: string; publicKey: string }) =>
  apiPost<{ sshKey: SshKey }>(base, input, scopeInit()).then(
    (res) => res.sshKey,
  );

export const remove = (id: string) =>
  apiDelete(`${base}/${encodeURIComponent(id)}`, undefined, scopeInit());
