export type PageScope = "project" | "organization";

/** Scoped apps API base: /v1/apps{sub} on project pages, /v1/org/apps{sub} on org pages. */
export const appsPath = (scope: PageScope, sub = "") =>
  scope === "organization" ? `/v1/org/apps${sub}` : `/v1/apps${sub}`;
