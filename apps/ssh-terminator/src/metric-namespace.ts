import { ConfigError } from "./errors";

/** The sandbox platform's base CloudWatch namespace — duplicated privately
 * from the manager's constants (the runner/supervisor precedent): local/test
 * fallback only, never published to in cloud mode. */
const BASE_METRIC_NAMESPACE = "OneCLI/SandboxPlatform";

/**
 * Resolve the CloudWatch namespace this process publishes to (step 6) —
 * the terminator's copy of the sandbox platform's one namespace law.
 *
 * Per-env in cloud (`OneCLI/SandboxPlatform/<env>`): dev and prod share one
 * AWS account, so the base namespace would merge their dimensionless series
 * and both envs' alarms would watch the blend. Cloud mode must name it
 * explicitly — the PutMetricData IAM condition is exact-match, so a silent
 * fallback to the base would publish into AccessDenied: total metric loss
 * with fire-and-forget emitters and NOT_BREACHING alarms (nothing would
 * ever turn red). Local/test falls back to the base constant.
 *
 * `cloudMode` is this process's own "we run deployed" signal (a Secrets
 * Manager ARN being present), passed in by its config seam.
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
