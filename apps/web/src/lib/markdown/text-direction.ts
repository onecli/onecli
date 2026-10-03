/**
 * Base text direction for mixed Hebrew/Arabic + English prose.
 *
 * Browsers default every block to LTR, so a Hebrew answer renders with its
 * bullets on the wrong side and its English terms reordering the sentence.
 * `dir="auto"` alone is not enough for model output: it keys on the FIRST
 * strong character, and agents routinely open a Hebrew line with an English
 * term ("Dev: אף אחד מ-4 פריטי התוכנית...", "**Sparklines** (גרפי מגמה)").
 * So direction is decided by the share of RTL letters in the prose (code,
 * URLs and code-ish tokens don't vote), with the message's direction kept
 * for any block that mixes the two.
 *
 * PERFORMANCE: the input is UNTRUSTED text up to TURN_MESSAGE_MAX_LENGTH
 * (100K), re-scanned on every render of a streaming turn. Every pass here
 * is linear: one split on whitespace, then anchored tests and two letter
 * counts per token. No nested quantifiers - `\S*X\S*` over a 100K
 * whitespace-free string backtracks quadratically (seconds per render).
 */
export type TextDirection = "rtl" | "ltr";

const WHITESPACE = /\s+/;
/**
 * Letters of the right-to-left scripts. Script properties (not code-point
 * ranges) so combining marks - Hebrew niqqud, Arabic tashkeel - and digits
 * never count as letters and skew the vote.
 */
const RTL_LETTER =
  /(?=\p{L})[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/gu;
/** Every letter of any script: Latin in all its extensions, Greek, Cyrillic, CJK. */
const ANY_LETTER = /\p{L}/gu;
/**
 * A token that is clearly not prose - a URL, key=value, a path, code - is
 * left out of the vote: LTR by nature, it would drown a short Hebrew
 * sentence that merely mentions it. Markdown already keeps code and link
 * URLs out (they are separate node types); the plain-text bubbles rely on
 * this filter alone.
 */
const NON_PROSE_TOKEN = /[=<>{}[\]\\/@`]|:\/\//;
/** A fence in plain text (a pasted snippet): everything up to the next
 *  fence is code, which never votes. */
const FENCE = /^(?:```|~~~)/;

/**
 * A message is RTL once RTL letters are at least this share of its letters.
 * Hebrew answers are dense with English product terms (Cloudflare, API
 * Token, KPIs): on real replies a strict majority flipped 58-78% Hebrew
 * text to LTR, while an English reply quoting a Hebrew word never gets
 * near 30%.
 */
const RTL_MESSAGE_SHARE = 0.3;

const count = (text: string, letters: RegExp): number =>
  text.match(letters)?.length ?? 0;

/** Letter counts over prose tokens only. */
const countLetters = (text: string): { rtl: number; total: number } => {
  let rtl = 0;
  let total = 0;
  let inFence = false;
  for (const token of text.split(WHITESPACE)) {
    if (FENCE.test(token)) inFence = !inFence;
    else if (!inFence && !NON_PROSE_TOKEN.test(token)) {
      rtl += count(token, RTL_LETTER);
      total += count(token, ANY_LETTER);
    }
  }
  return { rtl, total };
};

/** Direction of a whole message (see `RTL_MESSAGE_SHARE`). */
export const messageDirection = (text: string): TextDirection => {
  const { rtl, total } = countLetters(text);
  return rtl > 0 && rtl >= total * RTL_MESSAGE_SHARE ? "rtl" : "ltr";
};

/**
 * Direction of one block (paragraph, list, heading, quote, cell) inside a
 * message whose direction is `base`. A block with no RTL letters is LTR (an
 * English line or command inside a Hebrew answer). A block that has RTL
 * letters keeps an RTL message's direction, so mixed Hebrew/English lines
 * never flip sides mid-answer; inside an LTR message it turns RTL only when
 * RTL letters are the majority.
 */
export const blockDirection = (
  text: string,
  base: TextDirection,
): TextDirection => {
  const { rtl, total } = countLetters(text);
  if (rtl === 0) return "ltr";
  if (base === "rtl") return "rtl";
  return rtl * 2 >= total ? "rtl" : "ltr";
};
