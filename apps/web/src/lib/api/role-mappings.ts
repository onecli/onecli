import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "./client";
import type {
  RoleMappingRow,
  CreateRoleMappingInput,
  UpdateRoleMappingInput,
  RoleMappingImpact,
} from "./types";

// Group→role mappings (step 15) — organization-scoped. Highest priority first.
const base = "/v1/org/role-mappings";

export const list = () => apiGet<RoleMappingRow[]>(base);

export const create = (input: CreateRoleMappingInput) =>
  apiPost<RoleMappingRow>(base, input);

export const update = (id: string, input: UpdateRoleMappingInput) =>
  apiPatch<RoleMappingRow>(`${base}/${id}`, input);

export const remove = (id: string) => apiDelete(`${base}/${id}`);

/** Reassign priorities from a full order (index 0 = highest). */
export const reorder = (orderedIds: string[]) =>
  apiPut<RoleMappingRow[]>(`${base}/order`, { orderedIds });

/** Dry-run: how many members would change role under the proposed mapping. */
export const preview = (input: { groupId: string; role: "admin" | "member" }) =>
  apiPost<RoleMappingImpact>(`${base}/preview`, input);
