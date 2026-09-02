import { flattenToLine } from "@onecli/agent-protocol";

/**
 * The ONE derivation of a memory's index line, shared by the turn-start
 * context (turn-context-service) and the file projection's memory/index.md
 * (home-sync-service) — so the two indexes can never disagree about
 * what a memory "is called" (step 9 lifted this out of turn-context).
 */

export const MEMORY_INDEX_LINE_CLIP = 160;

/** Flatten to one line (the shared render normalization) then ellipsis-clip
 * — the flatten is `flattenToLine`, not a re-implementation. */
export const clipLine = (raw: string, max: number): string => {
  const line = flattenToLine(raw);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The index line's text: description, else title, else the content's first
 * meaningful line — derived at render time so an edit can never desync it. */
export const indexLineText = (memory: {
  title: string | null;
  description: string | null;
  content: string;
}): string => {
  if (memory.description) return memory.description;
  if (memory.title) return memory.title;
  const firstLine = memory.content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
};
