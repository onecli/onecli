// ── GraphQL operation classification (fail-closed) ──────────────────────────
//
// Several providers expose one `POST /graphql` endpoint for both reads and
// writes, so an endpoint-level rule cannot tell "list issues" from "create a
// pull request". Catalog tools tagged with `graphqlOps` discriminate on the
// buffered request body instead: a `query`-tagged tool matches only a document
// that is PROVABLY a pure query, and a `mutation`-tagged tool matches
// everything else.
//
// This is the TypeScript twin of the gateway's `policy-engine/src/graphql.rs`.
// The two ports MUST stay byte-locked (the shared corpus pins them): both
// implement the same minimal document scanner rather than a full GraphQL
// parser, precisely so no parser-behavior drift can open a gap between the
// TS reflection/evaluator and the live Rust decision.
//
// FAIL-CLOSED LAW - every doubtful input classifies as "mutation":
// - missing / empty body                          → mutation
// - body that is not a JSON object with a string
//   `query` field (covers 16KB-buffer truncation,
//   which breaks the JSON)                        → mutation
// - an envelope whose top level does not carry
//   EXACTLY ONE literal `"query"` key (duplicate
//   keys are a parser differential: we read
//   last-wins, an upstream might read first-wins
//   - so is any escape sequence inside a
//   top-level key)                                → mutation
// - unparsable / unbalanced GraphQL document      → mutation
// - any `mutation` or `subscription` operation
//   ANYWHERE in the document (even when
//   `operationName` selects a query - GitHub
//   would execute only the selected op, but we
//   refuse to reason about selection)             → mutation
// - any definition that is not a query
//   (shorthand `{`, `query`, or `fragment`)       → mutation
// - a document with no executable operation       → mutation
//
// The scanner only needs to find DEFINITION BOUNDARIES, which in GraphQL are
// top-level (brace-depth 0) constructs: an operation (`query` / `mutation` /
// `subscription` or the anonymous shorthand `{`) or a `fragment`. Strings,
// block strings, and comments are skipped so their contents can never confuse
// the depth tracking; header tokens between a definition keyword and its
// selection set (names, variable defs, directives) are irrelevant to the kind.

export type GraphqlOpKind = "query" | "mutation";

/**
 * Classify a raw request body (the JSON envelope `{"query": "..."}`).
 * Returns "query" only for a provably pure query document; "mutation" for
 * everything else, per the fail-closed law above.
 */
export const classifyGraphqlBody = (
  body: string | undefined | null,
): GraphqlOpKind => {
  if (body === undefined || body === null || body.length === 0)
    return "mutation";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "mutation";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return "mutation";
  const document = (parsed as Record<string, unknown>)["query"];
  if (typeof document !== "string") return "mutation";
  // Parser-differential guard: `JSON.parse` is last-wins on duplicate keys,
  // but an upstream's parser might be first-wins - a duplicate `"query"` key
  // would then execute a different document than the one classified. Demand
  // exactly one LITERAL top-level `"query"` key (an escaped key like
  // `"quer\u0079"` also fails - legitimate clients never escape it), so the
  // classified document is provably the one every JSON parser extracts.
  if (countTopLevelLiteralQueryKeys(body) !== 1) return "mutation";
  return classifyGraphqlDocument(document);
};

/**
 * Count top-level object keys that are LITERALLY `query` in raw JSON text.
 * Returns -1 (→ fail closed) when any top-level key contains a backslash
 * escape, since a decoded key could then alias `query` without matching
 * literally. Assumes `text` already parsed as a JSON object (checked by the
 * caller), so the scan only needs string/depth tracking, not validation.
 */
const countTopLevelLiteralQueryKeys = (text: string): number => {
  let count = 0;
  let depth = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i] as string;
    if (c === '"') {
      // Scan the string, tracking escapes; a top-level key is a depth-1
      // string followed (after whitespace) by `:`.
      const start = i + 1;
      let hasEscape = false;
      i += 1;
      while (i < len && text[i] !== '"') {
        if (text[i] === "\\") {
          hasEscape = true;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (i >= len) return -1; // unterminated (can't happen post-parse)
      const value = text.slice(start, i);
      i += 1; // closing quote
      let j = i;
      while (
        j < len &&
        (text[j] === " " ||
          text[j] === "\t" ||
          text[j] === "\n" ||
          text[j] === "\r")
      )
        j += 1;
      if (depth === 1 && text[j] === ":") {
        if (hasEscape) return -1;
        if (value === "query") count += 1;
      }
      continue;
    }
    if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") depth -= 1;
    i += 1;
  }
  return count;
};

/** Classify a GraphQL document string. "query" iff every definition is a
 * query operation or a fragment, with at least one query operation. */
export const classifyGraphqlDocument = (document: string): GraphqlOpKind => {
  const src = document;
  const len = src.length;
  let i = 0;
  let depth = 0;
  /** Between definitions (at depth 0, before the next definition's first
   * token). The first token of each definition decides its kind. */
  let expectingDefinition = true;
  let sawQueryOperation = false;

  while (i < len) {
    const c = src[i] as string;

    // Insignificant characters (GraphQL "ignored tokens").
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "," ||
      c === "\uFEFF"
    ) {
      i += 1;
      continue;
    }
    // Comment: to end of line.
    if (c === "#") {
      while (i < len && src[i] !== "\n" && src[i] !== "\r") i += 1;
      continue;
    }
    // Block string: """ ... """ (backslash-escaped `\"""` inside).
    if (src.startsWith('"""', i)) {
      i += 3;
      while (i < len && !src.startsWith('"""', i)) {
        i += src[i] === "\\" && src.startsWith('\\"""', i) ? 4 : 1;
      }
      if (i >= len) return "mutation"; // unterminated → fail closed
      i += 3;
      continue;
    }
    // String: " ... " with backslash escapes.
    if (c === '"') {
      i += 1;
      while (i < len && src[i] !== '"') {
        i += src[i] === "\\" ? 2 : 1;
      }
      if (i >= len) return "mutation"; // unterminated → fail closed
      i += 1;
      continue;
    }

    if (expectingDefinition && depth === 0) {
      // First token of a definition decides its kind.
      if (c === "{") {
        // Anonymous shorthand operation - a query by spec.
        sawQueryOperation = true;
        expectingDefinition = false;
        depth += 1;
        i += 1;
        continue;
      }
      const word = readName(src, i);
      if (word === null) return "mutation"; // not a definition start → fail closed
      i += word.length;
      if (word === "query") {
        sawQueryOperation = true;
        expectingDefinition = false;
        continue;
      }
      if (word === "fragment") {
        expectingDefinition = false;
        continue;
      }
      // mutation, subscription, or anything unknown (incl. future spec
      // additions) → fail closed.
      return "mutation";
    }

    // Inside a definition (header or selection set): track nesting only.
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth < 0) return "mutation"; // unbalanced → fail closed
      if (depth === 0 && c === "}") expectingDefinition = true;
      i += 1;
      continue;
    }
    // Any other token (names, punctuation like `:` `=` `@` `$` `!` `...`,
    // numbers) is part of the definition - skip one character; names are not
    // needed here.
    i += 1;
  }

  if (depth !== 0) return "mutation"; // unbalanced → fail closed
  if (!expectingDefinition) return "mutation"; // dangling header, no body → fail closed
  return sawQueryOperation ? "query" : "mutation";
};

/** Read a GraphQL Name ([_A-Za-z][_0-9A-Za-z]*) at `start`, or null. */
const readName = (src: string, start: number): string | null => {
  const isStart = (ch: string): boolean =>
    ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
  const isPart = (ch: string): boolean =>
    isStart(ch) || (ch >= "0" && ch <= "9");
  if (start >= src.length || !isStart(src[start] as string)) return null;
  let end = start + 1;
  while (end < src.length && isPart(src[end] as string)) end += 1;
  return src.slice(start, end);
};
