import {
  MEMORY_DESCRIPTION_MAX_LENGTH,
  MEMORY_FILE_CONTENT_MAX_CHARS,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  MEMORY_TITLE_MAX_LENGTH,
  flattenToLine,
} from "@onecli/agent-protocol";
import { z } from "zod";

/**
 * Zod surfaces for the agent-memory routes and the memory_* MCP tools
 * (plans/hosted-agents-v2.md step 8). Bounds live here so both doors — the
 * dashboard routes and the platform-tool dispatch — enforce one contract;
 * the supervisor's JSON tool schemas mirror them by eye
 * (apps/sandbox-supervisor/src/capabilities/memory.ts states that law).
 * Title/description/file-content caps come from @onecli/agent-protocol's
 * memory-file module — the file format and the doors must agree, and the
 * harvester (which cannot import this package) reads them there.
 */

export const MEMORY_AUTHOR_KINDS = ["user", "agent"] as const;
export type MemoryAuthorKind = (typeof MEMORY_AUTHOR_KINDS)[number];

export const MEMORY_OPS = ["save", "restore"] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

/** Bounds shared by the dashboard routes and the MCP tools. */
export {
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  MEMORY_DESCRIPTION_MAX_LENGTH,
  MEMORY_FILE_CONTENT_MAX_CHARS,
  MEMORY_TITLE_MAX_LENGTH,
} from "@onecli/agent-protocol";
/**
 * The TOOL door's content cap — sized so a worst-case JSON-escaped
 * memory_save (every char escaping to two) plus the envelope still fits
 * MAX_TOOL_ARGS_CHARS (32k); tool ARGS cannot truncate, so a memory legal
 * HERE must never be unsavable through the tool door. The dashboard and the
 * file harvest accept MEMORY_FILE_CONTENT_MAX_CHARS (100k) — they don't ride
 * the tool-args pipe; a big memory stays tool-writable only in parts, which
 * the memory fragment says out loud.
 */
export const MEMORY_CONTENT_MAX_LENGTH = 12_000;
export const MEMORY_SEARCH_QUERY_MAX_LENGTH = 500;

const keyField = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_KEY_MAX_LENGTH)
  .regex(
    MEMORY_KEY_PATTERN,
    'Keys are lowercase words separated by single hyphens, like "deploy-notes"',
  );

const singleLine = (value: string) => !value.includes("\n");

/**
 * Title/description end render-stable: after the single-line refusal (a
 * human deserves the message, not a silent flatten), `flattenToLine` strips
 * the control characters the file renderer would strip anyway — so a stored
 * value round-trips `memory/<key>.md` byte-for-byte and an untouched
 * projection can never read back as "edited".
 */
const titleField = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_TITLE_MAX_LENGTH)
  .refine(singleLine, { message: "Title is a single line" })
  .transform(flattenToLine)
  .refine((value) => value.length > 0, { message: "Title is required" });

const descriptionField = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_DESCRIPTION_MAX_LENGTH)
  .refine(singleLine, {
    message: "Description is a single line. Details belong in the content",
  })
  .transform(flattenToLine)
  .refine((value) => value.length > 0, { message: "Description is required" });

/** The tool door's content field (the 32k tool-args pipe). */
const contentField = z
  .string()
  .trim()
  .min(1)
  .max(
    MEMORY_CONTENT_MAX_LENGTH,
    `Memory content is limited to ${MEMORY_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters per save: split it into linked memories, or edit the memory file directly for longer content`,
  );

/** The dashboard/file door's content field. The chars cap is the coarse,
 * human-facing law; the exact deliverability check (`memoryFileFitsFrame`,
 * bytes) runs in the service on the FINAL merged state — only there are
 * key+title+description+content all known. */
const fileContentField = z
  .string()
  .trim()
  .min(1)
  .max(
    MEMORY_FILE_CONTENT_MAX_CHARS,
    `Memory content is limited to ${MEMORY_FILE_CONTENT_MAX_CHARS.toLocaleString("en-US")} characters: split it into linked memories`,
  );

/** Loose key for lookups: an ill-formed key should read as "no memory named
 * that" (useful), not as a format lecture (noise). */
const lookupKeyField = z.string().trim().min(1).max(MEMORY_KEY_MAX_LENGTH);

/** POST /v1/agents/:agentId/memories */
export const createMemorySchema = z
  .object({
    key: keyField,
    content: fileContentField,
    title: titleField.optional(),
    description: descriptionField.optional(),
  })
  .strict();

/** PATCH /v1/agents/:agentId/memories/:memoryId — partial; `key` is immutable
 * (it is the agent's own upsert handle and step 9's file name). Null clears
 * title/description. */
export const updateMemorySchema = z
  .object({
    title: titleField.nullable().optional(),
    description: descriptionField.nullable().optional(),
    content: fileContentField.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to update",
  });

const searchQueryField = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_SEARCH_QUERY_MAX_LENGTH);

/** GET /v1/agents/:agentId/memories?q= */
export const memoryListQuerySchema = z.object({
  q: searchQueryField.optional(),
});

/** memory_save — create-or-update by key. */
export const memorySaveArgsSchema = z
  .object({
    key: keyField,
    content: contentField,
    title: titleField.optional(),
    description: descriptionField.optional(),
  })
  .strict();

/** memory_list takes no arguments. */
export const memoryListArgsSchema = z.object({}).strict();

/** memory_search */
export const memorySearchArgsSchema = z
  .object({ query: searchQueryField })
  .strict();

/** memory_get */
export const memoryGetArgsSchema = z.object({ key: lookupKeyField }).strict();
