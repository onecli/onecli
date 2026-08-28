import type { AppAvailabilityProvider } from "./types";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud filters the connect picker by the org allowlist —
// injected by `ensureEditionDefaults()`, keeping the cloud module out of
// client bundles; onprem has no provider (availability is never restricted).
const slot = createEditionSlot<AppAvailabilityProvider | null>(
  "appAvailability",
  null,
);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultAppAvailability = (p: AppAvailabilityProvider) =>
  slot.setCloudDefault(p);

export const getAppAvailability = (): AppAvailabilityProvider | null =>
  slot.get();
