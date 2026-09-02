import { hostname } from "node:os";
import {
  OriginConfigError,
  resolvePublicOrigins,
} from "@onecli/api/lib/public-origins";

/**
 * Adapter configuration — every address is config with a local default
 * (§3.14 rule 3), read once at boot. Mirrors `apps/runner/src/config.ts`:
 * a malformed anchor token is a config error (exit 2), never a retry loop.
 */

export interface AdapterConfig {
  /** The `cha_` registration anchor. The instance's own bearer is minted at
   * registration (per-instance identity); the anchor only proves membership —
   * and remains the bearer against an old control plane that mints nothing. */
  token: string;
  /** The instance's stable name — the key its registration row survives
   * restarts under. Unset, it derives from the hostname: unique per ECS task
   * and per container with zero configuration (compose and `pnpm dev` both
   * set an explicit name). */
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
  /** The dashboard's public origin — where "fix it" buttons point. Resolved
   * by the shared resolver (`@onecli/api/lib/public-origins`): the canonical
   * ONECLI_EXTERNAL_URL, the APP_URL alias, then the warned legacy bind
   * seed; empty string when nothing is configured (buttons are simply
   * omitted — the localhost default would point Slack users at their own
   * machines). */
  appUrl: string;
  /** True when `appUrl` came from the deprecated ONECLI_BIND_HOST seed —
   * the adapter logs one deprecation line at boot. */
  appUrlFromLegacyBind: boolean;
}

export class ConfigError extends Error {}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const loadConfig = (env: NodeJS.ProcessEnv): AdapterConfig => {
  const token = env.CHANNEL_ADAPTER_TOKEN ?? "";
  if (!token.startsWith("cha_")) {
    throw new ConfigError(
      'CHANNEL_ADAPTER_TOKEN must be set and start with "cha_". install.sh provisions it; scripts/dev-check.mjs mints one for dev.',
    );
  }
  // The dashboard-origin chain (canonical, alias, legacy bind seed) comes
  // from the ONE resolver — public-origins is a zero-import leaf, safe to
  // bundle here, and it takes a caller-supplied env bag exactly like this
  // function does. A malformed ONECLI_EXTERNAL_URL becomes the adapter's
  // usual exit-2 ConfigError (the same boot-throw posture as the api-server).
  let resolved: ReturnType<typeof resolvePublicOrigins>;
  try {
    resolved = resolvePublicOrigins({
      externalUrl: env.ONECLI_EXTERNAL_URL,
      appUrl: env.APP_URL,
      nextPublicAppUrl: env.NEXT_PUBLIC_APP_URL,
      bindHost: env.ONECLI_BIND_HOST,
      appPort: env.ONECLI_APP_PORT,
    });
  } catch (err) {
    if (err instanceof OriginConfigError) throw new ConfigError(err.message);
    throw err;
  }
  return {
    token,
    name: env.CHANNEL_ADAPTER_NAME?.trim() || `channel-adapter-${hostname()}`,
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
    appUrl: resolved.externalConfigured ? resolved.app : "",
    appUrlFromLegacyBind: resolved.sources.external.source === "legacy-bind",
  };
};
