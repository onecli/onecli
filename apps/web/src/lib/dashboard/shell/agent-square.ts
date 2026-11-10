/**
 * The rail's agent square when the agent has no photo: initials on a
 * colour picked from the name, so fifty agents are
 * fifty different squares rather than fifty identical glyphs. The colour
 * is a hue, not a palette index, so it stays stable as names come and go
 * and reads on both themes with the fixed lightness below.
 */

export const agentInitials = (name: string): string => {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const chars = Array.from(words[0]!);
    return chars.slice(0, 2).join("").toUpperCase();
  }
  return (
    (Array.from(words[0]!)[0] ?? "") + (Array.from(words[1]!)[0] ?? "")
  ).toUpperCase();
};

/** A stable hue (0..359) for a name: the same name, the same colour. */
export const agentHue = (name: string): number => {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % 360;
};

/** Inline background for the square: muted, mid-lightness, so white
 *  initials read on it in both themes. */
export const agentSquareStyle = (
  name: string,
): { backgroundColor: string } => ({
  backgroundColor: `oklch(0.58 0.11 ${agentHue(name)})`,
});
