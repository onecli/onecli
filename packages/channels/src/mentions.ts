/**
 * The OUTBOUND mention grammar — the model's side of the mention contract,
 * provider-neutral by design (Slack renders `<@U…>`, a future Teams provider
 * renders its own token; the grammar the model writes never changes).
 *
 * The model writes `@[Exact Platform Name]`. That syntax — not raw provider
 * tokens — is deliberate: raw model-authored `<@U…>` / `<!channel>` has been
 * escaped-on-output since the first Slack post shipped (the anti-broadcast
 * fence), and it STAYS escaped forever. The platform resolves `@[Name]`
 * against identities it verified itself and emits the provider token from
 * the resolved id — the model never controls the wire bytes.
 *
 * Matching is EXACT (case-insensitive, whitespace-collapsed) and the
 * directory is linked teammates only — the decision record: a fuzzy or
 * unique-prefix match can ping the WRONG person, which is the worst failure
 * mode, while a failed exact match degrades to visible plain text plus a
 * next-turn note listing the real names. Fuzzy discovery is the
 * find_recipient tool's job (the roadmap's PR 3), not the renderer's.
 */

/** One `@[Name]` occurrence in a model answer. */
export interface MentionToken {
  /** The name inside the brackets, as written (trimmed, unnormalized). */
  name: string;
  /** Span of the whole `@[Name]` token in the source text. */
  start: number;
  end: number;
}

/**
 * Mention names a message can carry — matches the inbound decoder's lookup
 * cap: past this, extra tokens stay literal text. A real answer mentions a
 * handful of people; dozens is a runaway or an attack.
 */
export const MAX_MENTION_TOKENS = 20;

/** A name longer than this is not a name — same clamp the inbound decoder
 * applies to decoded display names. */
const MAX_NAME_CHARS = 80;

/**
 * `@[` … `]` with no nesting and no newline — a name is one line. The body
 * bound admits an 80-char name whose every character was entity-escaped
 * (`&` → `&amp;` quintuples): the Slack renderer runs this over
 * ALREADY-ESCAPED text, and a real name must still match there. The name
 * clamp below stays 80 — the regex bound is transport slack, not a wider
 * name allowance. `[^\]\n]` cannot backtrack catastrophically (single
 * character class).
 */
const MENTION_TOKEN_RE = /@\[([^\]\n]{1,400})\]/g;

/**
 * The canonical form both sides of the contract compare on: trimmed,
 * inner whitespace collapsed, case-folded. The resolver normalizes its
 * directory names the same way — the match is exact AFTER this, so
 * "dan  abramov" and "Dan Abramov" are the same name, while "Dan" and
 * "Dan Abramov" never are.
 */
export const normalizeMentionName = (raw: string): string =>
  raw.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Every `@[Name]` token in a model answer, in order, capped. Blank and
 * over-long names are skipped (left as literal text — the degrade rule),
 * not errors. The CALLER decides which spans are live (e.g. the Slack
 * renderer skips tokens inside code stashes by position).
 */
export const scanMentionTokens = (text: string): MentionToken[] => {
  const tokens: MentionToken[] = [];
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    if (tokens.length >= MAX_MENTION_TOKENS) break;
    const name = (match[1] ?? "").trim();
    if (!name || name.length > MAX_NAME_CHARS) continue;
    tokens.push({
      name,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
};

/** The distinct normalized names in an answer — what the resolver is asked
 * about (deduped so one name asked five times costs one lookup). */
export const mentionNamesOf = (text: string): string[] => [
  ...new Set(scanMentionTokens(text).map((t) => normalizeMentionName(t.name))),
];

/**
 * Rewrite every `@[Name]` token through `replace` — the RENDERER's door, so
 * the token grammar lives here once and each provider only decides what a
 * resolved or failed mention looks like on its wire. `replace` gets the raw
 * inner name (untrimmed spans included) and the whole token; returning the
 * token unchanged leaves it literal. Blank and over-long names stay literal
 * without consulting `replace` — the scanner's same skip rule.
 */
export const replaceMentionTokens = (
  text: string,
  replace: (name: string, token: string) => string,
): string =>
  text.replace(MENTION_TOKEN_RE, (token, raw: string) => {
    const name = raw.trim();
    if (!name || name.length > MAX_NAME_CHARS) return token;
    return replace(name, token);
  });

/**
 * Plain `@word` runs in prose that are NOT `@[Name]` tokens — the
 * near-miss surface. The caller intersects these with the directory: a
 * plain mention that MATCHES a linked teammate pinged nobody while looking
 * to the model like it worked, so it must be reported (the write-side twin
 * of the read-side rule that transcripts teach by example).
 *
 * Deliberately shallow: up to three capitalizable words after `@`, stopping
 * at punctuation — candidates only; matching against real names decides.
 * Skips `@[` (the real grammar) and bare emails (user@host is not a
 * mention). Capped like the scanner.
 */
export const plainMentionCandidatesOf = (text: string): string[] => {
  const out = new Set<string>();
  const re = /(^|[\s(])@([\p{L}\p{N}][\p{L}\p{N} ._-]{0,79})/gmu;
  for (const match of text.matchAll(re)) {
    if (out.size >= MAX_MENTION_TOKENS) break;
    const at = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (text[at + 1] === "[") continue; // the real grammar
    if (at > 0 && /[\p{L}\p{N}]/u.test(text[at - 1] ?? "")) continue; // email-ish
    const run = (match[2] ?? "").trim();
    if (!run) continue;
    // Longest-first prefixes of up to 3 words: "Dan Abramov said" offers
    // "Dan Abramov said", "Dan Abramov", "Dan" - the caller matches against
    // real names, so only true names hit.
    const words = run.split(/\s+/).slice(0, 3);
    for (let n = words.length; n >= 1; n -= 1) {
      out.add(normalizeMentionName(words.slice(0, n).join(" ")));
      if (out.size >= MAX_MENTION_TOKENS) break;
    }
  }
  return [...out];
};
