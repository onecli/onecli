import { apiGet } from "./client";

// App availability (policy-engine step 7): the workspace-scoped derive-read
// backing the connect-picker filter. The org config surface is EE
// (`@/ee/app-availability/api`), matching its EE-registered endpoints.

/**
 * The apps available to the current workspace. `restricted:false` (OSS, or an
 * "open" org) means unfiltered — every app available.
 */
export interface AvailableApps {
  restricted: boolean;
  providers: string[];
}

/** Workspace-scoped: the apps this workspace may connect. */
export const available = () => apiGet<AvailableApps>("/v1/apps/available");
