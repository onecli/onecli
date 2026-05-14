export const DISPLAY_NAME_MIN_LEN = 2;
export const DISPLAY_NAME_MAX_LEN = 50;

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
