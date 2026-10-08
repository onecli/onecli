/**
 * How a tool call's ARGUMENTS read in the transcript: the one argument that
 * says what the call did (for the row's preview), and the arguments as
 * pretty JSON split into tokens for coloring. Pure, so every decision is
 * unit-tested and the components stay thin.
 *
 * SECURITY: every string in and out is untrusted model/tool text. These
 * helpers only reshape text; the components render it as text nodes.
 */

/** Arguments that, when present, are the "what" of a call, in priority order. */
const PRIMARY_ARGS = [
  "command",
  "cmd",
  "sql",
  "query",
  "q",
  "search",
  "pattern",
  "file_path",
  "path",
  "url",
  "prompt",
  "message",
  "name",
  "id",
] as const;

const PREVIEW_MAX = 120;

const parseObject = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : null;
  } catch {
    return null;
  }
};

const oneLine = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX
    ? `${flat.slice(0, PREVIEW_MAX - 1)}…`
    : flat;
};

/** The call's primary argument on one clipped line, or null when there is
 * none: `echo hello && ls /` for `{"command":"echo hello && ls /"}`. Input
 * that is not a JSON object is previewed as it is. */
export const toolInputPreview = (input: string | undefined): string | null => {
  if (!input?.trim()) return null;
  const args = parseObject(input);
  if (!args) return oneLine(input);
  for (const key of PRIMARY_ARGS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return null;
};

/** Pretty-print JSON; anything else is returned unchanged. */
export const prettyJson = (text: string): { text: string; json: boolean } => {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[")))
    return { text, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
};

export type JsonTokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "punct"
  | "space";

/**
 * Tokenize pretty-printed JSON for coloring. The tokens concatenate back to
 * the input exactly (tested), so the component renders the same text, only
 * in colored spans, never as HTML.
 */
export const tokenizeJson = (
  text: string,
): { kind: JsonTokenKind; text: string }[] => {
  const out: { kind: JsonTokenKind; text: string }[] = [];
  const re =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/g;
  for (const m of text.matchAll(re)) {
    const [, str, colon, num, literal, punct, space, other] = m;
    if (str !== undefined) {
      out.push({ kind: colon === undefined ? "string" : "key", text: str });
      if (colon !== undefined) out.push({ kind: "punct", text: colon });
    } else if (num !== undefined) out.push({ kind: "number", text: num });
    else if (literal !== undefined)
      out.push({ kind: "literal", text: literal });
    else if (punct !== undefined) out.push({ kind: "punct", text: punct });
    else if (space !== undefined) out.push({ kind: "space", text: space });
    else if (other !== undefined) out.push({ kind: "punct", text: other });
  }
  return out;
};
