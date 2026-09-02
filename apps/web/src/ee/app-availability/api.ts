import { apiGet, apiPut, queryKeys } from "@/lib/api";

// The org-admin app-availability config surface (policy-engine step 7). The
// backing endpoints are EE-registered (/v1/org/app-availability), so the
// client + types live in the EE overlay; the shared `lib/api` keeps only the
// workspace-scoped derive-read (`available`), whose route ships in OSS. The
// config query key SPREADS the shared `queryKeys.appAvailability.all()` so
// broad invalidations from shared mutations still cover this cache.

export type AppAvailabilityMode = "open" | "restricted";

/** A named rule: a set of principals (users + groups) granted a set of apps. */
export interface AvailabilityRule {
  /** Present for an existing rule (drives the diff on save); absent = new. */
  id?: string;
  name?: string | null;
  userIds: string[];
  groupIds: string[];
  providers: string[];
}

export interface AppAvailabilityConfig {
  mode: AppAvailabilityMode;
  rules: AvailabilityRule[];
}

export const availabilityConfigKey = () =>
  [...queryKeys.appAvailability.all(), "config"] as const;

/** Org-scoped (admin): read the availability toggle + rules. */
export const getConfig = () =>
  apiGet<AppAvailabilityConfig>("/v1/org/app-availability");

/** Org-scoped (admin): replace the availability toggle + rules. */
export const setConfig = (input: AppAvailabilityConfig) =>
  apiPut<AppAvailabilityConfig>("/v1/org/app-availability", input);
