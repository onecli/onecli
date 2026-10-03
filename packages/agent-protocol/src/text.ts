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
 * A single line of printable text, clamped: C0 control characters and DEL
 * dropped (the newline included), then every whitespace run (the Unicode
 * line/paragraph separators included) collapsed to one space, trimmed. A
 * crafted label can never open a new line of instructions. For names,
 * labels, titles. Content that must keep its newlines uses `stripControl`.
 * Built from char codes rather than a regex range so no literal control byte
 * appears in this source.
 */
export const cleanLabel = (raw: string, max = 80): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

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
