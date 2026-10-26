/**
 * The phone keyboard bridge: a canvas never summons a touch device's software keyboard, so the view keeps an
 * off-screen text field the person focuses with the Keyboard button, and
 * every change to that field becomes VNC key events on the agent's screen.
 *
 * Why a diff and not key events: a software keyboard sends `keydown` with
 * key "Unidentified" (Android) or nothing usable at all for composed text,
 * autocorrect replaces whole words, and an IME composes before it commits.
 * The field's VALUE is the one thing every keyboard updates truthfully, so
 * each `input` event is compared with the value before it: characters that
 * went away become BackSpace, characters that arrived become their keysym.
 * The field holds a sentinel so a BackSpace on an "empty" field still has
 * something to delete (and so still fires). noVNC's own mobile UI does the
 * same.
 */

/** X11 keysyms the bridge sends for editing keys (keysymdef.h). */
export const XK_BACKSPACE = 0xff08;
export const XK_TAB = 0xff09;
export const XK_RETURN = 0xff0d;

/** What the field holds between keystrokes. Underscores, as noVNC's own
 * mobile input does: no autocorrect engine rewrites a run of them. The
 * field is put back to exactly this after every send. */
export const KEYBOARD_SENTINEL = "_".repeat(64);

/**
 * The keysym for one character (one code point). Latin-1 maps one to one;
 * everything else uses X11's direct Unicode keysym range (0x01000000 + code
 * point), the same fallback noVNC's own keysym lookup uses. Whether the
 * screen can type a character outside the active keymap is up to the VNC
 * server (plain ASCII, what sign-in forms need, always is). A newline is
 * Return and a tab is Tab; other control characters have no meaning on a
 * screen and are dropped (null).
 */
export const keysymFor = (char: string): number | null => {
  if (char === "\n" || char === "\r") return XK_RETURN;
  if (char === "\t") return XK_TAB;
  const code = char.codePointAt(0);
  if (code === undefined || code < 0x20 || code === 0x7f) return null;
  if (code <= 0xff) return code;
  return 0x01000000 + code;
};

/**
 * The key presses that turn `before` into `after`: BackSpace once per code
 * point removed after their common prefix, then each added code point's
 * keysym. Compared by code point, never UTF-16 unit, so an emoji is one
 * key and one BackSpace.
 */
export const keystrokesFor = (before: string, after: string): number[] => {
  const was = [...before];
  const now = [...after];
  let common = 0;
  while (
    common < was.length &&
    common < now.length &&
    was[common] === now[common]
  )
    common += 1;
  const keys: number[] = [];
  for (let i = common; i < was.length; i += 1) keys.push(XK_BACKSPACE);
  for (const char of now.slice(common)) {
    const keysym = keysymFor(char);
    if (keysym !== null) keys.push(keysym);
  }
  return keys;
};
