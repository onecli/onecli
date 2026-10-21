/**
 * The GitHub account kind on a connection card. GitHub calls a team account
 * an "Organization", which reads like OneCLI's own organization level, so
 * the card always names the vendor. Anything else falls back as-is.
 */
export const accountTypeLabel = (
  accountType: string | null | undefined,
): string | undefined => {
  if (accountType === "Organization") return "GitHub organization";
  if (accountType === "User") return "GitHub user";
  return accountType ?? undefined;
};
