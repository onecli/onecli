/**
 * When an approval card's detail value is prose: a message template, an
 * email body, a before → after. Prose reads whole, in its own block under
 * its label; anything else sits inline after its label. The web card, the
 * Slack card and the gateway (which puts prose first) apply this one rule,
 * so a value reads the same way on every surface.
 *
 * Pure and dependency-free: safe for the browser bundle.
 */

/** Past this many characters a value reads as prose. */
export const LONG_VALUE_CHARS = 80;

/** Whether `value` reads as prose: past {@link LONG_VALUE_CHARS}, or with
 *  any line break (including the Unicode line and paragraph separators,
 *  which also break a line where the card shows it). */
export const isProse = (value: string): boolean =>
  value.length > LONG_VALUE_CHARS || /[\r\n\u2028\u2029]/u.test(value);
