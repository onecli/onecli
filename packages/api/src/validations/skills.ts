import { z } from "zod";

/**
 * Zod surfaces for the skill routes (plans/hosted-agents-v2.md step 9).
 * Bounds live here so both doors — the workspace surface and the org surface —
 * enforce one contract; they are ALSO what makes the sync-frame protocol
 * safe: every cap below feeds the MAX_SYNC_PART_BYTES packing arithmetic in
 * home-sync-service, so nothing authorable can ever exceed one frame.
 */

export const SKILL_SCOPES = ["agent", "workspace", "organization"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** The directory name inside the sandbox — kebab, immutable after create. */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The builtin gateway skill's directory — user skills may never claim it. */
export const RESERVED_SKILL_NAMES = ["onecli-gateway"] as const;

export const SKILL_DESCRIPTION_MAX_LENGTH = 500;
export const SKILL_CONTENT_MAX_LENGTH = 24_000;

export const SKILL_FILE_PATH_MAX_LENGTH = 128;
/** Relative, ≤2 segments, each starting [a-z0-9] — ".." and absolute paths
 * are unrepresentable. */
export const SKILL_FILE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;
/** Collides with the rendered SKILL.md on case-insensitive filesystems. */
export const RESERVED_SKILL_FILE_PATHS = ["skill.md"] as const;
export const SKILL_FILE_CONTENT_MAX_LENGTH = 24_000;
export const MAX_FILES_PER_SKILL = 5;

/**
 * The governing per-skill cap: body + every extra file together. You cannot
 * max everything at once — this is what bounds the whole materialized set
 * (and therefore the sync part count) multiplicatively.
 */
export const MAX_SKILL_TOTAL_CHARS = 32_000;

/** Availability bounds per tier (the MAX_CRONS_PER_AGENT reasoning); tiers
 * never cross-consume. */
export const MAX_SKILLS_PER_AGENT = 10;
export const MAX_SKILLS_PER_WORKSPACE = 20;
export const MAX_SKILLS_PER_ORG = 20;

const singleLine = (value: string) => !value.includes("\n");

const nameField = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(
    SKILL_NAME_PATTERN,
    'Skill names are lowercase words separated by single hyphens, like "release-checklist"',
  )
  .refine(
    (name) => !(RESERVED_SKILL_NAMES as readonly string[]).includes(name),
    { message: "That name is reserved for the built-in gateway skill" },
  );

const descriptionField = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_DESCRIPTION_MAX_LENGTH)
  .refine(singleLine, {
    message:
      "Description is a single line. It is how the agent decides when to load the skill",
  });

const contentField = z.string().trim().min(1).max(SKILL_CONTENT_MAX_LENGTH);

export const skillFileSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(SKILL_FILE_PATH_MAX_LENGTH)
    .regex(
      SKILL_FILE_PATH_PATTERN,
      'File paths are relative, at most two lowercase segments, like "references/api.md"',
    )
    .refine(
      (path) =>
        !(RESERVED_SKILL_FILE_PATHS as readonly string[]).includes(
          path.toLowerCase(),
        ),
      { message: "SKILL.md is written from the skill's own fields" },
    ),
  content: z.string().min(1).max(SKILL_FILE_CONTENT_MAX_LENGTH),
});

const filesField = z
  .array(skillFileSchema)
  .max(MAX_FILES_PER_SKILL)
  .refine((files) => new Set(files.map((f) => f.path)).size === files.length, {
    message: "File paths must be unique within a skill",
  });

const totalWithinBudget = (body: {
  content?: string;
  files?: { content: string }[];
}) =>
  (body.content?.length ?? 0) +
    (body.files ?? []).reduce((sum, file) => sum + file.content.length, 0) <=
  MAX_SKILL_TOTAL_CHARS;

const budgetMessage = `A skill's body and files together are limited to ${MAX_SKILL_TOTAL_CHARS.toLocaleString("en-US")} characters`;

/** POST /v1/skills — workspace tier, or agent tier when agentId is present. */
export const createSkillSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    content: contentField,
    enabled: z.boolean().optional(),
    agentId: z.string().trim().min(1).max(100).optional(),
    files: filesField.optional(),
  })
  .strict()
  .refine(totalWithinBudget, { message: budgetMessage });

/** POST /v1/org/skills — the org tier has no agent. */
export const createOrgSkillSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    content: contentField,
    enabled: z.boolean().optional(),
    files: filesField.optional(),
  })
  .strict()
  .refine(totalWithinBudget, { message: budgetMessage });

/** PATCH — partial; `name` is immutable (absent from the schema: it is the
 * directory name and the agent's own reference). The total budget is
 * re-checked in the SERVICE against the merged row — a content-only PATCH
 * must not smuggle the sum over the cap. */
export const updateSkillSchema = z
  .object({
    description: descriptionField.optional(),
    content: contentField.optional(),
    enabled: z.boolean().optional(),
    files: filesField.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to update",
  });

// ── The skill_* MCP tool arguments (the agent door) ─────────────────────────
// Same bounds as the HTTP doors — one contract, two shells (the crons
// precedent). Skills are addressed BY NAME here, never by id: the name is
// the directory the agent sees in its own skills root. Extra files stay
// dashboard-only (the 32k tool-args pipe cannot carry body + files anyway),
// so none of these schemas accept `files`.

/** skill_create — always the agent's own tier. */
export const skillCreateArgsSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    content: contentField,
  })
  .strict();

/** skill_list takes no arguments. */
export const skillListArgsSchema = z.object({}).strict();

/** skill_update — by name, agent tier only; at least one change. */
export const skillUpdateArgsSchema = z
  .object({
    name: nameField,
    description: descriptionField.optional(),
    content: contentField.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 1, {
    message: "Nothing to update",
  });

/** skill_delete — by name, agent tier only. */
export const skillDeleteArgsSchema = z
  .object({
    name: nameField,
  })
  .strict();
