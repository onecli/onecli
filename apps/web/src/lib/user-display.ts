/**
 * Up-to-two-letter initials for an avatar fallback: derived from the name when
 * present, otherwise the first character of the email, otherwise "?".
 */
export const getInitials = (
  name: string | null,
  email: string | null,
): string => {
  if (name) {
    return name
      .split(" ")
      .map((n) => n.charAt(0))
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  if (email) return email.charAt(0).toUpperCase();
  return "?";
};
