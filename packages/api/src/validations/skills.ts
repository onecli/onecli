import { cleanLabel } from "@onecli/agent-protocol/text";
import { z } from "zod";

/**
 * Zod surfaces for the skill routes (plans/hosted-agents-v2.md step 9).
 * Bounds live here so both doors — the agent surface and the org surface —
 * enforce one contract; they are ALSO what makes the sync-frame protocol
 * safe: every cap below feeds the MAX_SYNC_PART_BYTES packing arithmetic in
 * home-sync-service, so nothing authorable can ever exceed one frame.
 */

export const SKILL_SCOPES = ["agent", "organization"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** The directory name inside the sandbox — kebab, immutable after create. */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The builtin gateway skill's directory — user skills may never claim it. */
export const RESERVED_SKILL_NAMES = ["onecli-gateway"] as const;

/** The Agent Skills standard's limit (agentskills.io/specification), so a
 * description written for Claude or Codex fits as it is. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** Unicode tag characters (U+E0000 to U+E007F: invisible, yet a model reads
 * them as ASCII) and any surrogate not part of a pair (invalid UTF-16, which
 * would not survive UTF-8; in a `u` regex a proper pair is one code point,
 * so `\p{Cs}` matches only the lone ones). cleanLabel covers neither. */
const INVISIBLE_TAGS_AND_LONE_SURROGATES = /[\u{E0000}-\u{E007F}]|\p{Cs}/gu;

/**
 * A skill description as stored and shown: one line of printable text.
 * Control characters (C0, DEL, C1), invisible format characters (bidi
 * overrides, zero-width chars, BOM), Unicode tag characters (an invisible
 * copy of ASCII that models still read) and lone surrogates are dropped,
 * and whitespace runs become one space. The description is how the agent
 * decides when to load a skill, so nothing in it may hide or reorder text,
 * and in JSON a control character escapes to 6 characters, which broke the
 * size bounds of tool results built from descriptions. Every door that
 * stores a description applies this (the dashboard, the API, the agent's
 * tools, zip imports, the Git library), and so do the readers (the SKILL.md
 * render, the skill views, the agent's tool results), for rows stored
 * before it existed.
 */
export const cleanSkillDescription = (
  raw: string,
  max = Number.MAX_SAFE_INTEGER,
): string =>
  // The whitespace control characters (tab, line breaks, NEL) become spaces
  // first, so one between two words keeps them apart; cleanLabel then drops
  // every other control or format character (the BOM included, which a
  // `\s` would have turned into a space), collapses whitespace, and clamps
  // to `max` without splitting a surrogate pair.
  cleanLabel(
    raw
      .replace(/[\t\n\v\f\r\u0085]/g, " ")
      .replace(INVISIBLE_TAGS_AND_LONE_SURROGATES, ""),
    max,
  );

/** A hand-written SKILL.md body (the editor and the agent's tools). */
export const SKILL_CONTENT_MAX_LENGTH = 24_000;
/**
 * An imported SKILL.md body (from a zip): the standard sets no limit, and
 * real skills run long (Anthropic's own skill-creator is 33k characters).
 * 120,000 characters, in line with the Git library's 120 KB SKILL.md
 * limit. Such a body can still be edited in the dashboard; it just can't
 * grow past its imported length.
 */
export const IMPORTED_SKILL_CONTENT_MAX_LENGTH = 120_000;

export const SKILL_FILE_PATH_MAX_LENGTH = 200;
/** How deep a file may sit inside a skill folder (fixtures/incidents/x.json
 * = 3). Any case, dots, dashes and underscores; each segment starts with a
 * letter, digit or underscore, so "..", hidden files and absolute paths are
 * unrepresentable. The dashboard's file editor mirrors this pattern. */
export const SKILL_FILE_MAX_DEPTH = 6;
export const SKILL_FILE_PATH_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*){0,5}$/;

/**
 * Whether `path` can't sit in one skill folder beside `taken` (lowercased
 * paths): the same path in another case (case-insensitive filesystems), or
 * a file where another path needs a folder, or the reverse. Either would
 * make the sandbox write fail on every sync.
 */
export const skillPathClashes = (
  path: string,
  taken: ReadonlySet<string>,
): boolean => {
  const lower = path.toLowerCase();
  if (taken.has(lower)) return true;
  const segments = lower.split("/");
  for (let i = 1; i < segments.length; i += 1) {
    if (taken.has(segments.slice(0, i).join("/"))) return true;
  }
  for (const other of taken) {
    if (other.startsWith(`${lower}/`)) return true;
  }
  return false;
};
/** Collides with the rendered SKILL.md on case-insensitive filesystems. */
export const RESERVED_SKILL_FILE_PATHS = ["skill.md"] as const;
/** One hand-written file (the dashboard editor and the JSON doors). */
export const SKILL_FILE_CONTENT_MAX_LENGTH = 24_000;
/** Hand-written files per skill (the dashboard editor). Imported skills
 * (zip) use the folder limits below. */
export const MAX_FILES_PER_SKILL = 5;

/**
 * The hand-written cap: body + every extra file together, for skills
 * written in the editor. Imported skills are bounded by the folder limits.
 */
export const MAX_SKILL_TOTAL_CHARS = 32_000;

/** An imported skill (from a zip): its files (SKILL.md included) and its
 * bytes. */
export const MAX_IMPORTED_SKILL_FILES = 200;
export const MAX_IMPORTED_SKILL_BYTES = 10 * 1024 * 1024;
/** One zip upload (it may hold several skills). */
export const MAX_SKILL_ZIP_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_ZIP_ENTRIES = 1_000;
export const MAX_SKILL_ZIP_UNPACKED_BYTES = 50 * 1024 * 1024;

/** Availability bounds per tier (the MAX_CRONS_PER_AGENT reasoning); tiers
 * never cross-consume. */
export const MAX_SKILLS_PER_AGENT = 10;
export const MAX_SKILLS_PER_ORG = 20;

/**
 * What one tier's skills may hold together, checked at the import door (the
 * only way folders come in; hand-written skills stay small under their own
 * caps). An agent carries its own tier plus the org's, re-sent whole on
 * every sync generation:
 *  - bytes: 20 MB together, ~150 frame-sized parts, which leaves a full
 *    library budget and a full memory tier room inside MAX_SYNC_PARTS;
 *  - manifestBytes: every file is one path on the sync's final frame,
 *    measured as `skillManifestBytes` measures it, so both tiers together
 *    stay well inside one frame beside the library's manifest budget.
 * The composer's `fitSkillsToSync` is the braces past these.
 */
export const SKILL_TIER_BUDGETS = {
  agent: { bytes: 10 * 1024 * 1024, manifestBytes: 30_000 },
  organization: { bytes: 10 * 1024 * 1024, manifestBytes: 15_000 },
} as const satisfies Record<
  SkillScope,
  { bytes: number; manifestBytes: number }
>;

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

/** The single-line refusal comes first (a person who typed a newline
 * deserves the message, not a silent flatten); then the stored value is
 * cleaned, and one left with nothing printable is refused. */
const descriptionField = z
  .string()
  .trim()
  .min(1)
  .max(SKILL_DESCRIPTION_MAX_LENGTH)
  .refine(singleLine, {
    message:
      "Description is a single line. It is how the agent decides when to load the skill",
  })
  .transform((value) => cleanSkillDescription(value))
  .refine((value) => value.length > 0, {
    message: "Description is required",
  });

const contentField = z.string().trim().min(1).max(SKILL_CONTENT_MAX_LENGTH);
/** PATCH may carry an imported skill's longer body; the service holds a
 * hand-written skill to SKILL_CONTENT_MAX_LENGTH. */
const patchContentField = z
  .string()
  .trim()
  .min(1)
  .max(IMPORTED_SKILL_CONTENT_MAX_LENGTH);

export const skillFileSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(SKILL_FILE_PATH_MAX_LENGTH)
    .regex(
      SKILL_FILE_PATH_PATTERN,
      'File paths are relative, at most six folders deep, like "references/api.md"',
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
  .refine(
    (files) => {
      const taken = new Set<string>();
      return files.every((file) => {
        if (skillPathClashes(file.path, taken)) return false;
        taken.add(file.path.toLowerCase());
        return true;
      });
    },
    {
      message:
        "File paths must be unique, and a file can't share a name with a folder",
    },
  );

const totalWithinBudget = (body: {
  content?: string;
  files?: { content: string }[];
}) =>
  (body.content?.length ?? 0) +
    (body.files ?? []).reduce((sum, file) => sum + file.content.length, 0) <=
  MAX_SKILL_TOTAL_CHARS;

const budgetMessage = `A skill's body and files together are limited to ${MAX_SKILL_TOTAL_CHARS.toLocaleString("en-US")} characters`;

/** POST /v1/skills — always an agent's own skill (a hosted agent of the
 * caller's workspace). Organization skills go through /v1/org/skills. */
export const createSkillSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    content: contentField,
    enabled: z.boolean().optional(),
    // Only the MISSING case gets its own words (the default names no field);
    // every other failure keeps Zod's message.
    agentId: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? "agentId is required: the agent the skill belongs to"
            : undefined,
      })
      .trim()
      .min(1)
      .max(100),
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
    content: patchContentField.optional(),
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

/** skill_import: a skill zip a person sent in chat, by the path it landed
 * at (`attachments/<turn-id>/<file>.zip`). */
export const skillImportArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(512),
  })
  .strict();
