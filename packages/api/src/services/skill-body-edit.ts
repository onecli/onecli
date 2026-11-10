import { ServiceError } from "./errors";
import { SKILL_CONTENT_MAX_LENGTH } from "../validations/skills";

/**
 * A change in place to a skill body, from the agent's skill_update: the
 * agent sends only the change, so a skill of any length is editable inside
 * the 32k tool-args pipe. Pure: the service reads the body, applies this,
 * and writes the result only if the body is still the one it read.
 */
export interface SkillBodyEdit {
  edits?: { find: string; replace: string }[];
  append?: string;
}

/**
 * Where `pattern` first occurs in `text`, and how often: the count stops at
 * 2 (overlapping matches count), which is all an edit needs to tell a
 * missing, a unique and an ambiguous `find` apart. Knuth-Morris-Pratt, so a
 * call costs O(text + pattern) whatever the input: `indexOf` is
 * O(text x pattern) on crafted input (a run of one character with a single
 * other one in the middle), which on a 120,000-character body held the
 * shared api's event loop for about a third of a second per call.
 */
const occurrences = (
  text: string,
  pattern: string,
): { first: number; count: number } => {
  // The empty string occurs everywhere (the schema refuses it anyway).
  if (pattern === "") return { first: -1, count: 2 };
  // fallback[i]: the length of the longest proper prefix of pattern[0..i]
  // that is also its suffix.
  const fallback = new Uint32Array(pattern.length);
  for (let i = 1, k = 0; i < pattern.length; i += 1) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fallback[k - 1] ?? 0;
    if (pattern[i] === pattern[k]) k += 1;
    fallback[i] = k;
  }
  let first = -1;
  let count = 0;
  for (let i = 0, k = 0; i < text.length; i += 1) {
    while (k > 0 && text[i] !== pattern[k]) k = fallback[k - 1] ?? 0;
    if (text[i] === pattern[k]) k += 1;
    if (k === pattern.length) {
      if (count === 0) first = i - k + 1;
      count += 1;
      if (count === 2) break;
      k = fallback[k - 1] ?? 0;
    }
  }
  return { first, count };
};

/**
 * Apply the edits in order, each `find` against the body as the previous
 * edit left it, then `append` at the end. A `find` that occurs zero times or
 * more than once is refused with the reason (never guessed), and so is a
 * result that is empty or over the one body limit. Every refusal means
 * nothing was saved.
 */
export const applySkillBodyEdit = (
  body: string,
  { edits = [], append }: SkillBodyEdit,
): string => {
  let next = body;
  edits.forEach(({ find, replace }, index) => {
    const { first, count } = occurrences(next, find);
    if (count !== 1) {
      throw new ServiceError(
        "UNPROCESSABLE",
        count === 0
          ? `Edit ${index + 1}: its find text is not in the skill. Copy it exactly from the current SKILL.md (without the comment line under the frontmatter). Nothing was changed`
          : `Edit ${index + 1}: its find text occurs more than once in the skill. Include more surrounding text so it matches one place. Nothing was changed`,
      );
    }
    next = `${next.slice(0, first)}${replace}${next.slice(first + find.length)}`;
  });
  if (append !== undefined) next = `${next.trimEnd()}\n\n${append}`;
  next = next.trim();
  if (next.length === 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The edits leave the skill empty. Nothing was changed",
    );
  }
  if (next.length > SKILL_CONTENT_MAX_LENGTH) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Instructions are limited to ${SKILL_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters, and these edits make ${next.length.toLocaleString("en-US")}. Nothing was changed`,
    );
  }
  return next;
};
