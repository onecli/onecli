import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

/**
 * The skills client (step 9): /v1/skills (workspace door, header-fenced) and
 * /v1/org/skills (org door). Types hand-mirrored from the service views
 * (`skill-service.ts`), dates as ISO strings — the house convention.
 */

export interface SkillFileInput {
  path: string;
  content: string;
}

export interface SkillSummary {
  id: string;
  /** "agent" | "workspace" | "organization" */
  scope: string;
  agentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
}

export interface Skill extends Omit<SkillSummary, "fileCount"> {
  content: string;
  files: SkillFileInput[];
}

export interface SkillInput {
  name: string;
  description: string;
  content: string;
  enabled?: boolean;
  /** Present = agent tier (a hosted agent of this workspace); absent = workspace tier. */
  agentId?: string;
  files?: SkillFileInput[];
}

export interface SkillPatch {
  description?: string;
  content?: string;
  enabled?: boolean;
  files?: SkillFileInput[];
}

// Encoded like every id that can arrive DECODED from the URL (`useParams`):
// an unencoded crafted segment would URL-normalize the request onto a
// different /v1 path under the caller's credentials.
const skillPath = (skillId: string) =>
  `/v1/skills/${encodeURIComponent(skillId)}`;
const orgSkillPath = (skillId: string) =>
  `/v1/org/skills/${encodeURIComponent(skillId)}`;

export const list = () => apiGet<{ skills: SkillSummary[] }>("/v1/skills");

export const get = (skillId: string) => apiGet<Skill>(skillPath(skillId));

export const create = (input: SkillInput) =>
  apiPost<Skill>("/v1/skills", input);

export const update = (skillId: string, patch: SkillPatch) =>
  apiPatch<Skill>(skillPath(skillId), patch);

export const remove = (skillId: string) => apiDelete(skillPath(skillId));

export const orgList = () =>
  apiGet<{ skills: SkillSummary[] }>("/v1/org/skills");

export const orgGet = (skillId: string) => apiGet<Skill>(orgSkillPath(skillId));

export const orgCreate = (input: Omit<SkillInput, "agentId">) =>
  apiPost<Skill>("/v1/org/skills", input);

export const orgUpdate = (skillId: string, patch: SkillPatch) =>
  apiPatch<Skill>(orgSkillPath(skillId), patch);

export const orgRemove = (skillId: string) => apiDelete(orgSkillPath(skillId));
