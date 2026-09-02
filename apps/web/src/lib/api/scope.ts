export type PageScope = "workspace" | "organization";

/** Scoped apps API base: /v1/apps{sub} on workspace pages, /v1/org/apps{sub} on org pages. */
export const appsPath = (scope: PageScope, sub = "") =>
  scope === "organization" ? `/v1/org/apps${sub}` : `/v1/apps${sub}`;
