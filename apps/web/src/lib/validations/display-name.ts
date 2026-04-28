/**
 * Single source of truth for client-side display-name validation. Used by the
 * agent / rule / secret / project create + rename forms so users see the same
 * inline error messages everywhere.
 *
 * Server-side schemas (`lib/validations/agent.ts`, etc.) are intentionally
 * looser (1–255 chars) so existing rows don't fail validation when re-saved.
 * This client validator enforces the friendlier 2–50-char limit on new input.
 */
export const DISPLAY_NAME_MIN_LEN = 2;
export const DISPLAY_NAME_MAX_LEN = 50;

/**
 * Returns an error message for invalid input, or `null` when valid.
 * An empty string returns `null` (pristine state — show helper, not error).
 */
export const validateDisplayName = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length < DISPLAY_NAME_MIN_LEN) {
    return `At least ${DISPLAY_NAME_MIN_LEN} characters`;
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LEN) {
    return `At most ${DISPLAY_NAME_MAX_LEN} characters`;
  }
  if (!/[a-z0-9]/i.test(trimmed)) {
    return "Must include at least one letter or number";
  }
  return null;
};
