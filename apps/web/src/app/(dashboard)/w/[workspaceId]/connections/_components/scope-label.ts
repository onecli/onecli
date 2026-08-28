/**
 * Scope → display-label mapping for inherited connections/secrets. The
 * defaults cover the scopes that exist (`organization`/`workspace`); any other
 * scope falls back to a capitalized form, and a new tier gets its label here.
 */
const DEFAULT_SCOPE_LABELS: Record<string, string> = {
  organization: "Organization",
  workspace: "Workspace",
};

export const labelForScope = (scope: string | null | undefined): string => {
  if (!scope) return "";
  return (
    DEFAULT_SCOPE_LABELS[scope] ??
    scope.charAt(0).toUpperCase() + scope.slice(1)
  );
};
