/**
 * Matches `/p/<projectId>` at the start of a pathname and captures the id.
 * Shared across sidebar, header, and navigation helpers so the pattern stays
 * consistent. Accepts both 16-char nanoid slugs and 36-char UUIDs.
 */
export const PROJECT_PATH_RE = /^\/p\/([a-z]{16}|[0-9a-f-]{36})(?=\/|$)/;

/**
 * Prefix an absolute dashboard path with `/p/<projectId>` if the current
 * pathname is already inside a project scope. Used by shared dashboard
 * components (connections tabs, overview cards, app detail) so a "Secrets"
 * tab click inside `/p/<id>/connections` keeps the project prefix instead of
 * jumping to the OSS top-level `/connections/secrets`.
 *
 * In OSS the regex never matches (no `/p/<id>/` URLs exist) so the input
 * path is returned unchanged — this is a no-op for self-hosted users.
 */
export const withProjectPrefix = (
  currentPathname: string,
  targetPath: string,
): string => {
  const match = currentPathname.match(PROJECT_PATH_RE);
  if (!match) return targetPath;
  return `/p/${match[1]}${targetPath}`;
};
