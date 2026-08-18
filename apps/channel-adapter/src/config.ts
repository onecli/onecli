/**
 * Adapter configuration — every address is config with a local default
 * (§3.14 rule 3), read once at boot. Mirrors `apps/runner/src/config.ts`:
 * a malformed anchor token is a config error (exit 2), never a retry loop.
 */

export interface AdapterConfig {
  /** The `cha_` registration/bearer token (the instance anchor). */
  token: string;
  name: string;
  /** The control plane's /v1 origin. */
  controlPlaneUrl: string;
  /** The gateway origin (its approvals API lives on the proxy port). */
  gatewayUrl: string;
  /** Config-feed poll cadence (ETag-cheap). */
  configPollMs: number;
  /** Batched work poll cadence. */
  workPollMs: number;
  /** Gateway approvals long-poll hold, seconds (the gateway holds ~30s). */
  approvalsPollSeconds: number;
  /** The dashboard's public origin — where "fix it" buttons point. First
   * non-empty of APP_URL then NEXT_PUBLIC_APP_URL (a present-but-empty
   * APP_URL falls through, matching `configuredAppUrl()`); empty string when
   * neither is set (buttons are simply omitted). */
  appUrl: string;
}

export class ConfigError extends Error {}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** First env var with a non-empty value after trimming — the local copy of
 * `configuredAppUrl()`'s rule (the adapter cannot import `packages/api`). A
 * present-but-empty var falls through to the next; `""` when none is set. */
const firstConfigured = (...values: (string | undefined)[]): string => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
};

export const loadConfig = (env: NodeJS.ProcessEnv): AdapterConfig => {
  const token = env.CHANNEL_ADAPTER_TOKEN ?? "";
  if (!token.startsWith("cha_")) {
    throw new ConfigError(
      'CHANNEL_ADAPTER_TOKEN must be set and start with "cha_". install.sh provisions it; scripts/dev-check.mjs mints one for dev.',
    );
  }
  return {
    token,
    name: env.CHANNEL_ADAPTER_NAME ?? "channel-adapter",
    controlPlaneUrl: (
      env.CONTROL_PLANE_URL ?? "http://localhost:10256"
    ).replace(/\/$/, ""),
    gatewayUrl: (env.GATEWAY_API_URL ?? "http://localhost:10255").replace(
      /\/$/,
      "",
    ),
    configPollMs: positiveInt(env.CHANNEL_ADAPTER_CONFIG_POLL_MS, 10_000),
    workPollMs: positiveInt(env.CHANNEL_ADAPTER_WORK_POLL_MS, 2_000),
    approvalsPollSeconds: positiveInt(
      env.CHANNEL_ADAPTER_APPROVALS_POLL_SECONDS,
      25,
    ),
    appUrl: firstConfigured(env.APP_URL, env.NEXT_PUBLIC_APP_URL).replace(
      /\/+$/,
      "",
    ),
  };
};
