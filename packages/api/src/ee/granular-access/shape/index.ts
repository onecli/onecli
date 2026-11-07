import { validateGitHubAppPolicy } from "./github-app";
import { validateDropboxPolicy } from "./dropbox";
import { validateGoogleDrivePolicy } from "./google-drive";
import { ServiceError } from "../../../services/errors";
import { axisOf } from "../../../lib/resource-axis";

type ShapeValidator = (
  metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
) => Promise<void>;

/** Each granular provider's resource axis and its deep shape check. */
const PROVIDERS: Record<string, { axis: string; validate: ShapeValidator }> = {
  "github-app": { axis: "repositories", validate: validateGitHubAppPolicy },
  dropbox: { axis: "folders", validate: validateDropboxPolicy },
  "google-drive": { axis: "driveFolders", validate: validateGoogleDrivePolicy },
};

/**
 * Provider-shape validation of a granular session policy — the write-time
 * validation semantics of the licensed granular_access feature, shared by
 * BOTH editions' default policy validators (cloud adds the plan gate on top;
 * a licensed self-host runs exactly this). Providers without a granular
 * config are accepted as-is. Only ever reached after
 * `assertEntitled("granular_access")` — the entitled-onprem default asserts
 * before delegating, and the cloud default asserts through the quota service.
 *
 * A policy written on ANOTHER provider's axis (Dropbox `folders` on a Drive
 * connection, say) is refused for every provider: the gateway can't enforce
 * it, so it refuses every request under it — never a scope worth storing.
 *
 * CLIENT-BUNDLE: the onprem default (`services/policy-onprem-validator`) is
 * reachable from client bundles via the providers barrel, so it loads this
 * licensed module LAZILY (`await import(...)` — a declared seam, never a
 * static dependency). Keep this module's own import graph client-safe anyway
 * (the per-provider validators, `ServiceError`, and the pure resource-axis
 * module only; never the quota/plan graph, the DB client, or Node builtins),
 * since `ee/granular-access/index.ts` imports it statically.
 */
export const validatePolicyShape = async (
  provider: string,
  metadata: Record<string, unknown> | null,
  policy: Record<string, unknown>,
): Promise<void> => {
  const config = PROVIDERS[provider];
  if (!config) return;
  const axis = axisOf(policy);
  if (axis && axis.key !== config.axis) {
    throw new ServiceError(
      "BAD_REQUEST",
      `${provider} connections are scoped with ${config.axis}, not ${axis.key}`,
    );
  }
  return config.validate(metadata, policy);
};
