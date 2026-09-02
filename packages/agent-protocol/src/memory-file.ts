import { createHash } from "node:crypto";
import {
  MAX_SYNC_PART_BYTES,
  MAX_SYNC_PARTS,
  syncFrameByteLength,
} from "./sync-budget";

/**
 * The memory file format — ONE definition of how a platform memory becomes
 * `memory/<key>.md` and how such a file reads back into memory fields.
 *
 * Lives here (not in @onecli/api) because both sides of the wire depend on
 * it: the control plane renders the projection, and the sandbox supervisor
 * harvests agent edits back out of it. One module means render and parse can
 * be pinned to each other by a property test instead of kept equal by eye.
 *
 * The projection is SELF-AUTHENTICATING: every rendered file carries a
 * `checksum:` frontmatter line — the SHA-256 of the whole file with the
 * checksum value blanked to zeros. "Is this file an unmodified projection?"
 * is therefore answerable locally, byte-exactly, and statelessly — after a
 * container restart, for a memory deleted platform-side, for a revision
 * pruned out of retention — with no database lookup and no supervisor state.
 * A forged checksum only suppresses the agent's OWN upload (the file reads
 * as pristine), which the agent could achieve by not editing the file at
 * all; it is a correctness device, never a trust boundary.
 */

/** Content cap for file-authored and dashboard-authored memories (chars).
 * The MCP tool keeps its own lower cap (the 32k tool-args pipe); files and
 * the dashboard editor share this one. The bytes predicate below is the
 * exact deliverability check — this is the human-facing coarse law. */
export const MEMORY_FILE_CONTENT_MAX_CHARS = 100_000;

/** Serialized budget for one upward `memory.write` frame, in UTF-8 bytes —
 * under the runner WS's silent 256KB drop with envelope headroom, the
 * MAX_SYNC_PART_BYTES reasoning pointed the other way. */
export const MAX_MEMORY_WRITE_BYTES = 150_000;

/** Metadata caps, mirrored from validations/memories.ts (the belt); the
 * harvester CLIPS parsed title/description to these rather than refusing —
 * metadata is a display label, content is data (never clipped). */
export const MEMORY_TITLE_MAX_LENGTH = 120;
export const MEMORY_DESCRIPTION_MAX_LENGTH = 300;

/** kebab-case — the upsert handle AND the projected/harvested file name.
 * ONE definition: the wire refines, the doors validate, and the harvester
 * filters with this exact pattern (a drifted copy would send names the
 * platform refuses, or refuse names it accepts). */
export const MEMORY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MEMORY_KEY_MAX_LENGTH = 80;

export const MEMORY_FILE_MANAGED_COMMENT =
  "<!-- Synced with OneCLI — edits to this file save to your platform memory; memory/index.md is generated. -->";

/** The legacy step-9 banner — recognized by the parser so files rendered
 * before this format change still parse cleanly. */
const LEGACY_MANAGED_COMMENT_PREFIX = "<!-- Managed by OneCLI";

const CHECKSUM_PLACEHOLDER = "0".repeat(64);
const CHECKSUM_LINE_PATTERN = /^(checksum: )([0-9a-f]{64})$/m;

/**
 * Strip control characters (keeping newline) plus the Unicode line/paragraph
 * separators U+2028/U+2029. The one sanitizer for platform-authored text
 * entering a model prompt — @onecli/api re-exports it from lib/text.
 */
export const stripControl = (raw: string): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0x2028 || code === 0x2029) return false;
      return (code >= 0x20 && code !== 0x7f) || ch === "\n";
    })
    .join("");

/**
 * The render normalization for single-line metadata (title/description):
 * control-stripped, newlines flattened to spaces, trimmed. Every write door
 * applies this too, so stored values round-trip the file format byte-for-
 * byte — the property `parse(render(m)) ≡ m` is honest, not aspirational.
 */
export const flattenToLine = (value: string): string =>
  stripControl(value).replaceAll("\n", " ").trim();

/** YAML folded block scalar — the one frontmatter shape that cannot be
 * broken by `:` or quotes in a single-line value. Exported so the skills
 * composer renders its frontmatter identically (one definition, not two). */
export const foldedScalar = (value: string): string =>
  `>-\n  ${flattenToLine(value)}`;

export interface MemoryFileFields {
  key: string;
  title: string | null;
  description: string | null;
  content: string;
}

const renderWithChecksum = (
  memory: MemoryFileFields,
  checksum: string,
): string =>
  [
    "---",
    `key: ${memory.key}`,
    ...(memory.title ? [`title: ${foldedScalar(memory.title)}`] : []),
    ...(memory.description
      ? [`description: ${foldedScalar(memory.description)}`]
      : []),
    `checksum: ${checksum}`,
    "---",
    MEMORY_FILE_MANAGED_COMMENT,
    "",
    memory.content,
    "",
  ].join("\n");

/** Exported for the harvester's content-hash bookkeeping — one impl. */
export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** `memory/<key>.md` as the projection ships it: frontmatter (key, folded
 * title/description, checksum), managed comment, blank line, content,
 * trailing newline. */
export const renderMemoryFile = (memory: MemoryFileFields): string => {
  const blanked = renderWithChecksum(memory, CHECKSUM_PLACEHOLDER);
  return renderWithChecksum(memory, sha256Hex(blanked));
};

/**
 * True iff `raw` is byte-identical to some projection render: blank the
 * checksum value, re-hash, compare. False on any edit, a missing checksum
 * (agent-created file), or a moved/duplicated line — every false means
 * "agent-authored bytes live here".
 */
export const isUnmodifiedProjection = (raw: string): boolean => {
  const match = CHECKSUM_LINE_PATTERN.exec(raw);
  if (!match) return false;
  const blanked =
    raw.slice(0, match.index) +
    match[1] +
    CHECKSUM_PLACEHOLDER +
    raw.slice(match.index + match[0].length);
  return sha256Hex(blanked) === match[2];
};

export interface ParsedMemoryFile {
  title?: string;
  description?: string;
  content: string;
}

const QUOTED = /^(['"])(.*)\1$/;

const unquote = (value: string): string => {
  const inner = QUOTED.exec(value)?.[2];
  return inner ?? value;
};

/**
 * Read a memory file back into fields — the inverse of `renderMemoryFile`,
 * tolerant of agent-authored files: BOM stripped, `\r\n` accepted, optional
 * frontmatter (absent → the whole file is content), plain or folded scalars,
 * optional quotes, unknown fields ignored, the managed comment (current or
 * legacy) dropped, body trimmed (stored content is trimmed at every door, so
 * trimming is round-trip-faithful). The filename stem — not any frontmatter
 * `key:` — is the authoritative key; `checksum:` is consumed by
 * `isUnmodifiedProjection`, not here.
 */
export const parseMemoryFile = (raw: string): ParsedMemoryFile => {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replaceAll(
    "\r\n",
    "\n",
  );
  const lines = text.split("\n");

  const fields: { title?: string; description?: string } = {};
  let bodyStart = 0;

  if (lines[0]?.trim() === "---") {
    const closing = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---",
    );
    if (closing > 0) {
      bodyStart = closing + 1;
      for (let i = 1; i < closing; i += 1) {
        const match = /^(title|description):\s*(.*)$/.exec(lines[i] ?? "");
        if (!match) continue;
        const name = match[1] === "title" ? "title" : "description";
        let value = (match[2] ?? "").trim();
        if (
          value === ">-" ||
          value === ">" ||
          value === "|" ||
          value === "|-"
        ) {
          // Block scalar: consume the indented continuation lines.
          const parts: string[] = [];
          let j = i + 1;
          while (j < closing && /^\s+\S/.test(lines[j] ?? "")) {
            parts.push((lines[j] ?? "").trim());
            j += 1;
          }
          value = parts.join(" ");
          i = j - 1;
        } else {
          value = unquote(value);
        }
        const flattened = flattenToLine(value);
        if (flattened.length > 0) fields[name] = flattened;
      }
    }
  }

  const body = lines.slice(bodyStart);
  const firstContent = body.findIndex((line) => line.trim() !== "");
  const firstLine = firstContent === -1 ? undefined : body[firstContent];
  if (
    firstLine !== undefined &&
    (firstLine === MEMORY_FILE_MANAGED_COMMENT ||
      firstLine.startsWith(LEGACY_MANAGED_COMMENT_PREFIX))
  ) {
    body.splice(firstContent, 1);
  }

  return { ...fields, content: body.join("\n").trim() };
};

/**
 * The exact ROUND-TRIP deliverability predicate — a memory that passes must
 * survive BOTH directions of the wire:
 *
 *  - DOWN: the rendered file fits a BARE single-file sync frame (worst-case
 *    stamps, no final-part extras — the composer ships extras on their own
 *    dedicated final part). Without it a maxed CJK memory passes the chars
 *    check and is then silently skipped by the part packer forever.
 *  - UP: an agent edit fits a `memory.write` frame (`MAX_MEMORY_WRITE_BYTES`,
 *    the SMALLER budget). Without it a memory the dashboard accepts (fits the
 *    200KB down-frame) can never be harvested back — the agent's own edit to
 *    it is unsyncable forever, savable through one door and lost through the
 *    other. The doors must agree, so the gate requires the tighter of the two.
 *
 * Enforced at every door that accepts the big cap.
 */
export const memoryFileFitsFrame = (memory: MemoryFileFields): boolean => {
  const path = `memory/${memory.key}.md`;
  const down =
    syncFrameByteLength({
      kind: "skills.changed",
      generation: 2_147_483_647,
      part: MAX_SYNC_PARTS,
      of: MAX_SYNC_PARTS,
      files: [{ path, content: renderMemoryFile(memory) }],
    }) <= MAX_SYNC_PART_BYTES;
  // The up-frame the harvester builds: content + metadata + a worst-case
  // writeId, matching apps/sandbox-supervisor/src/home/memory-harvest.ts.
  const up =
    syncFrameByteLength({
      kind: "memory.write",
      writeId: "x".repeat(100),
      key: memory.key,
      content: memory.content,
      ...(memory.title ? { title: memory.title } : {}),
      ...(memory.description ? { description: memory.description } : {}),
    }) <= MAX_MEMORY_WRITE_BYTES;
  return down && up;
};
