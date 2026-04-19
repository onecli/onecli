/**
 * Centralized environment variable access.
 *
 * All `process.env` reads should go through this file so that defaults,
 * fallbacks, and naming are managed in one place. Import from `@/lib/env`
 * instead of reading `process.env` directly.
 *
 * NEXT_PUBLIC_* vars are inlined at build time by Next.js — they work on
 * both client and server as long as the literal string appears in source.
 */

// ── App URLs ────────────────────────────────────────────────────────────

/** Web app base URL (e.g., `https://app.onecli.sh` or `http://localhost:10254`). */
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:10254";

/** Gateway API URL used by browser-side code (e.g., `http://localhost:10255`). */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:10255";

/**
 * Gateway URL used by server-side code when the web app calls the gateway
 * from within a Docker network (e.g., `host.docker.internal:10255`).
 */
export const GATEWAY_BASE_URL =
  process.env.GATEWAY_BASE_URL ?? "host.docker.internal:10255";

/**
 * Gateway host:port for constructing proxy URLs shown to users
 * (e.g., `localhost:10255`). No protocol prefix.
 */
export const API_BASE_URL = process.env.API_BASE_URL ?? "localhost:10255";

// ── Edition ─────────────────────────────────────────────────────────────

/** Build-time edition: `"cloud"` or `""` (OSS). */
export const EDITION = process.env.NEXT_PUBLIC_EDITION ?? "";

/** Convenience flag for cloud-specific logic. */
export const IS_CLOUD = EDITION === "cloud";

// ── Auth & Encryption ───────────────────────────────────────────────────

export const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "";

export const SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "";

export const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET ?? "";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

// ── Cloud: Cognito ──────────────────────────────────────────────────────

export const COGNITO_CLIENT_ID =
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";

export const COGNITO_DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "";

export const COGNITO_USER_POOL_ID =
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";

// ── Cloud: Stripe ───────────────────────────────────────────────────────

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";

export const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID ?? "";

export const STRIPE_BIZ_PRICE_ID = process.env.STRIPE_BIZ_PRICE_ID ?? "";

// ── Cloud: Notifications ────────────────────────────────────────────────

export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

export const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

// ── Cloud: exe.dev (NanoClaw deploy) ────────────────────────────────────

export const EXE_DEV_TOKEN = process.env.EXE_DEV_TOKEN ?? "";

// ── Cloud: KMS ──────────────────────────────────────────────────────────

export const KMS_KEY_ARN = process.env.KMS_KEY_ARN ?? "";

// ── Gateway TLS ─────────────────────────────────────────────────────────

export const GATEWAY_CA_CERT = process.env.GATEWAY_CA_CERT ?? "";

export const GATEWAY_CA_PEM_FILE = process.env.GATEWAY_CA_PEM_FILE ?? "";

// ── Logging & Runtime ───────────────────────────────────────────────────

export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const NODE_ENV = process.env.NODE_ENV ?? "development";

export const NEXT_RUNTIME = process.env.NEXT_RUNTIME ?? "";

/** User home directory (system). */
export const HOME = process.env.HOME ?? "";
