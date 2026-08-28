import type { AppAvailabilityProvider } from "../../providers";
import { deriveAvailableProviders } from "../services/app-availability-service";

/**
 * App-availability read seam (registered by the cloud edition). Backs
 * the connect-picker filter with the same allowlist the gateway enforces at
 * runtime. OSS never registers it, so every app stays available there.
 */
export const appAvailability: AppAvailabilityProvider = {
  getAvailableProviders: (workspaceId, organizationId) =>
    deriveAvailableProviders(workspaceId, organizationId),
};
