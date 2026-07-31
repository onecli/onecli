import { apiGet, apiPatch, apiDelete } from "./client";
import type { Project } from "./types";

// The org is normally derived from the /org/<id> path. The explicit override
// exists for the account-route Get Started picker, whose org comes from the
// default-org cookie instead of the URL; the server validates membership.
export const list = (options: { organizationId?: string } = {}) =>
  apiGet<Project[]>(
    "/v1/projects",
    options.organizationId
      ? { headers: { "X-Organization-Id": options.organizationId } }
      : undefined,
  );

export const rename = (id: string, name: string) =>
  apiPatch<Project>(`/v1/projects/${id}`, { name });

export const remove = (id: string) => apiDelete(`/v1/projects/${id}`);
