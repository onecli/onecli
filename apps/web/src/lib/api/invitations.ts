import { apiGet, apiPost, apiDelete, workspaceScope } from "./client";
import type { PendingInvitation, CreateInvitationInput } from "./types";

// Team invitations. Free on every edition — the org routes are admin-only,
// while redeeming one deliberately is not org-scoped: the person accepting is
// not a member yet.
const orgBase = "/v1/org/invitations";

export const list = () => apiGet<PendingInvitation[]>(orgBase);

/**
 * Returns the join link so the inviter can copy it, and whether an email
 * actually went out — a deployment with no mail provider gets `emailed: false`
 * rather than a false claim of delivery.
 */
export const create = (
  input: CreateInvitationInput,
  options: { workspaceId?: string } = {},
) =>
  apiPost<{ id: string; joinUrl: string; emailed: boolean }>(
    orgBase,
    input,
    workspaceScope(options.workspaceId),
  );

export const cancel = (invitationId: string) =>
  apiDelete(`${orgBase}/${invitationId}`);

export const accept = (token: string) =>
  apiPost<{ organizationId: string; organizationName: string }>(
    "/v1/invitations/accept",
    { token },
  );
