import { apiGet } from "./client";

// App availability (policy-engine step 7): the project-scoped derive-read
// backing the connect-picker filter. The org config surface is EE
// (`@/ee/app-availability/api`), matching its EE-registered endpoints.

/**
 * The apps available to the current project. `restricted:false` (OSS, or an
 * "open" org) means unfiltered — every app available.
 */
export interface AvailableApps {
  restricted: boolean;
  providers: string[];
}

/** Project-scoped: the apps this project may connect. */
export const available = () => apiGet<AvailableApps>("/v1/apps/available");
