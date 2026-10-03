import { ConfigError } from "./errors";

/** The base metric namespace: local/test fallback only, never published to
 * in cloud mode. */
const BASE_METRIC_NAMESPACE = "OneCLI/SandboxPlatform";

/**
 * Resolve the metric namespace this process publishes to. Cloud mode must
 * name it explicitly: a deployment scopes its metrics per environment, and a
 * silent fallback to the shared base would publish where nothing is watching
 * (or be refused outright). Local/test falls back to the base constant.
 *
 * `cloudMode` is this process's own "we run deployed" signal (a secret ARN
 * being present), passed in by its config seam.
 */
export const resolveMetricNamespace = (
  raw: string | undefined,
  cloudMode: boolean,
): string => {
  const trimmed = raw?.trim();
  if (trimmed) return trimmed;
  if (cloudMode) {
    throw new ConfigError(
      "SANDBOX_METRIC_NAMESPACE is required in cloud mode — the metrics " +
        "IAM grant is namespace-conditioned per env, and a silent fallback " +
        "to the shared base namespace would publish into AccessDenied.",
    );
  }
  return BASE_METRIC_NAMESPACE;
};
