import { apiDelete, apiGet, apiPatch, apiPost, refusal } from "./client";
import { apiUpload } from "@/lib/api-fetch";

/**
 * The skills client (step 9): /v1/skills (workspace door, header-fenced) and
 * /v1/org/skills (org door). Types hand-mirrored from the service views
 * (`skill-service.ts`), dates as ISO strings — the house convention.
 */

export interface SkillFileInput {
  path: string;
  content: string;
}

/** One file as the detail view returns it. Files the editor can't show
 *  (binary, or larger than one editor file) arrive with empty `content`
 *  and `editable: false`; saving the skill keeps them. */
export interface SkillFile extends SkillFileInput {
  bytes: number;
  binary: boolean;
  executable: boolean;
  editable: boolean;
}

/** What a zip import did, per skill (the server's ImportedSkillOutcome). */
export interface ImportedSkill {
  /** The saved skill (the same one when a name was replaced). */
  id: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  groups: Record<string, number>;
  skipped: { path: string; reason: string }[];
  replaced: boolean;
}

export interface SkillImportResult {
  imported: ImportedSkill[];
  problems: { folder: string; reason: string }[];
}

export interface SkillSummary {
  id: string;
  /** "agent" | "organization" */
  scope: string;
  agentId: string | null;
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
  files: SkillFile[];
}

export interface SkillInput {
  name: string;
  description: string;
  content: string;
  enabled?: boolean;
  /** The owning agent (a hosted agent of this workspace). Required: skills
   *  created through /v1/skills always belong to one agent. */
  agentId: string;
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

/** Upload a skill zip: into one agent, or (no agentId) the organization. */
export const importZip = async (
  file: File,
  agentId?: string,
): Promise<SkillImportResult> => {
  const path = agentId
    ? `/v1/skills/import?agentId=${encodeURIComponent(agentId)}`
    : "/v1/org/skills/import";
  const res = await apiUpload(path, file, { contentType: "application/zip" });
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as SkillImportResult;
};
