/**
 * Display-text helpers shared by every side of the wire that splices a
 * user- or provider-chosen string into platform voice (the control plane
 * composing a payload, the supervisor rendering the instruction doc, the
 * dashboard showing a card). One definition, so what the composer clamps is
 * exactly what the renderer accepts.
 *
 * Leaf-only and browser-safe (no imports): client code reaches it through
 * the `./text` subpath export, never the package barrel, which pulls in
 * `node:crypto`.
 */

/**
 * Invisible Unicode format characters (category Cf) a crafted label could use
 * to reorder or hide text: soft hyphen, Arabic letter mark, zero-width
 * space/joiners and LRM/RLM, bidi embeddings and overrides, word joiner and
 * invisible operators, bidi isolates, deprecated format controls, and the
 * BOM. Mirrored by `is_format_char` in the gateway's `secret_choice.rs`.
 */
export const isFormatChar = (code: number): boolean =>
  code === 0x00ad ||
  code === 0x061c ||
  code === 0x180e ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x206f) ||
  code === 0xfeff;

/** A control character (category Cc): C0, DEL or C1. Rust's
 * `char::is_control` is the same set. */
const isControlChar = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f);

/**
 * A single line of printable text, clamped: control characters (C0, DEL,
 * C1; the newline included) and invisible format characters (bidi
 * overrides/isolates, zero-width chars, BOM) dropped, then every whitespace
 * run (the Unicode line/paragraph separators included) collapsed to one
 * space, trimmed, and clamped to `max` UTF-16 code units, the unit a zod
 * `.max()` counts, without ever splitting a surrogate pair. A crafted label
 * can never open a new line of instructions or visually reorder text. For
 * names, labels, titles. Content that must keep its newlines uses
 * `stripControl`. Built from char codes rather than a regex range so no
 * literal control byte appears in this source.
 */
export const cleanLabel = (raw: string, max = 80): string => {
  const folded = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !isControlChar(code) && !isFormatChar(code);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  let out = "";
  for (const ch of folded) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
};

/**
 * The display cap for a custom (generic secret) connection's name, in UTF-16
 * code units, shared with the gateway (`display_label` in
 * `secret_choice.rs`), so `list_apps` and the `x-onecli-connections` header
 * show the agent the same text. Both sides are pinned to one corpus:
 * `custom-connection-label-cases.json`.
 */
export const MAX_CUSTOM_CONNECTION_LABEL_CHARS = 80;

/** What a custom connection with an empty or blank name is shown as, on
 * both sides of the wire. */
export const CUSTOM_CONNECTION_FALLBACK_LABEL = "Custom connection";

/** A custom connection's name as the agent sees it: cleaned, clamped, and
 * never empty. */
export const customConnectionLabel = (name: string): string =>
  cleanLabel(name, MAX_CUSTOM_CONNECTION_LABEL_CHARS) ||
  CUSTOM_CONNECTION_FALLBACK_LABEL;

/** RFC 1123 host: dot-separated LDH labels, lowercase, at least two of them. */
const BARE_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Longest hostname the DNS allows. */
export const MAX_HOSTNAME_CHARS = 253;

/**
 * Whether `host` is a bare lowercase hostname and nothing else: no scheme,
 * port, path, userinfo, query or fragment, and at least one dot. The gate
 * for any host about to be rendered as `https://<host>` for a person or an
 * agent to follow (a stored bound host, for instance), so a value with a
 * `/`, `@`, `?` or `#` in it is never handed out as a destination.
 */
export const isBareHostname = (host: string): boolean =>
  host.length <= MAX_HOSTNAME_CHARS && BARE_HOSTNAME.test(host);

/**
 * The agent's way to stay SILENT in a channel it overhears: an answer that is
 * exactly this token (any case, optional surrounding whitespace or markdown
 * emphasis) means "I read it and have nothing to add". Channels post nothing;
 * the dashboard shows a muted "stayed silent" line. Anything else - including
 * a real reply that merely mentions the token - is an answer.
 */
export const NO_REPLY_TOKEN = "[no reply]";

export const isNoReply = (answer: string | null | undefined): boolean => {
  if (!answer) return false;
  const bare = answer
    .trim()
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .trim();
  return bare.toLowerCase() === NO_REPLY_TOKEN;
};
