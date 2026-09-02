import { validateGitHubAppPolicy } from "./github-app";
import { validateDropboxPolicy } from "./dropbox";

/**
 * Provider-shape validation of a granular session policy — the write-time
 * validation semantics of the licensed granular_access feature, shared by
 * BOTH editions' default policy validators (cloud adds the plan gate on top;
 * a licensed self-host runs exactly this). Providers without a granular
 * config are accepted as-is. Only ever reached after
 * `assertEntitled("granular_access")` — the entitled-onprem default asserts
 * before delegating, and the cloud default asserts through the quota service.
 *
 * CLIENT-BUNDLE: the onprem default (`services/policy-onprem-validator`) is
 * reachable from client bundles via the providers barrel, so it loads this
 * licensed module LAZILY (`await import(...)` — a declared seam, never a
 * static dependency). Keep this module's own import graph client-safe anyway
 * (the per-provider validators + `ServiceError` only; never the quota/plan
 * graph, the DB client, or Node builtins), since `ee/granular-access/index.ts`
 * imports it statically.
 */
export const validatePolicyShape = async (
  provider: string,
  metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
): Promise<void> => {
  switch (provider) {
    case "github-app":
      return validateGitHubAppPolicy(metadata, policy);
    case "dropbox":
      return validateDropboxPolicy(metadata, policy);
  }
};
