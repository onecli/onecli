/**
 * The URL gate for model-written markdown: the last word on every `href` and
 * `src` the renderer emits.
 *
 * Same allowlist as react-markdown's `defaultUrlTransform`, which the chat
 * used before the streaming renderer: http(s), mailto, irc(s) and xmpp, plus
 * relative URLs (no scheme). Anything else, `javascript:`, `data:`,
 * `vbscript:`, a custom app scheme, becomes an empty string, so the element
 * keeps its text and loses its address.
 *
 * Why our own and not the renderer's: the streaming renderer's default is a
 * passthrough (it relies on its sanitize step), and a URL policy this
 * security-relevant should not depend on a library default staying put.
 * The sanitize step still runs first; this is the second, independent gate.
 */
const SAFE_PROTOCOL = /^(?:https?|ircs?|mailto|xmpp)$/i;

export const safeUrlTransform = (url: string): string => {
  const colon = url.indexOf(":");
  const questionMark = url.indexOf("?");
  const numberSign = url.indexOf("#");
  const slash = url.indexOf("/");
  // No scheme at all: a relative URL. A colon that only appears after the
  // first `/`, `?` or `#` is part of the path, query or fragment, not a
  // scheme.
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign)
  ) {
    return url;
  }
  return SAFE_PROTOCOL.test(url.slice(0, colon)) ? url : "";
};
