import type { AppAvailabilityProvider } from "./types";

// OSS default: no provider — availability is never restricted, so the connect
// picker shows every app (unchanged from before the seam). The EE editions
// register a provider that reads the org allowlist.
let _appAvailability: AppAvailabilityProvider | null = null;

export const initAppAvailability = (
  provider: AppAvailabilityProvider | null,
) => {
  _appAvailability = provider;
};

export const getAppAvailability = (): AppAvailabilityProvider | null =>
  _appAvailability;
