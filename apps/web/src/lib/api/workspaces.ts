import { apiGet, apiPatch, apiDelete } from "./client";
import type { Workspace } from "./types";

// The org is normally derived from the /org/<id> path. The explicit override
// exists for the account-route Get Started picker, whose org comes from the
// default-org cookie instead of the URL; the server validates membership.
export const list = (options: { organizationId?: string } = {}) =>
  apiGet<Workspace[]>(
    "/v1/workspaces",
    options.organizationId
      ? { headers: { "X-Organization-Id": options.organizationId } }
      : undefined,
  );

export const rename = (id: string, name: string) =>
  apiPatch<Workspace>(`/v1/workspaces/${id}`, { name });

export const remove = (id: string) => apiDelete(`/v1/workspaces/${id}`);
