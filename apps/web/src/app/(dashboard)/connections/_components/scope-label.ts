/**
 * Generic scope → display-label mapping for inherited connections/secrets.
 *
 * Feature-neutral: the defaults cover the scopes that exist in OSS
 * (`organization`/`project`); any other scope falls back to a capitalized form,
 * and callers may pass an `overrides` map to label additional tiers (e.g. a
 * cloud "partner" tier supplies `{ partner: "Partner" }`). OSS callers pass no
 * overrides, so behavior is unchanged.
 */
export type ScopeLabelMap = Record<string, string>;

const DEFAULT_SCOPE_LABELS: ScopeLabelMap = {
  organization: "Organization",
  project: "Project",
};

export const labelForScope = (
  scope: string | null | undefined,
  overrides?: ScopeLabelMap,
): string => {
  if (!scope) return "";
  return (
    overrides?.[scope] ??
    DEFAULT_SCOPE_LABELS[scope] ??
    scope.charAt(0).toUpperCase() + scope.slice(1)
  );
};
