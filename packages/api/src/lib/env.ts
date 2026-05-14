/**
 * Centralized environment variable access for the API package.
 *
 * Reads both `X` and `NEXT_PUBLIC_X` variants so this works in both
 * Next.js (where build-time NEXT_PUBLIC_ prefix is required) and
 * standalone Node.js (where plain env vars are used).
 */

// ── App URLs ────────────────────────────────────────────────────────────

export const APP_URL =
  process.env.APP_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:10254";

export const API_URL =
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:10255";

export const GATEWAY_BASE_URL =
  process.env.GATEWAY_BASE_URL ?? "host.docker.internal:10255";

export const API_BASE_URL = process.env.API_BASE_URL ?? "localhost:10255";

// ── Edition ─────────────────────────────────────────────────────────────

export const EDITION =
  process.env.EDITION ?? process.env.NEXT_PUBLIC_EDITION ?? "";

export const IS_CLOUD = EDITION === "cloud";

// ── Auth & Encryption ───────────────────────────────────────────────────

export const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "";

export const SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "";

export const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET ?? "";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

// ── Cloud: Cognito ──────────────────────────────────────────────────────

export const COGNITO_CLIENT_ID =
  process.env.COGNITO_CLIENT_ID ??
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ??
  "";

export const COGNITO_DOMAIN =
  process.env.COGNITO_DOMAIN ?? process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "";

export const COGNITO_USER_POOL_ID =
  process.env.COGNITO_USER_POOL_ID ??
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ??
  "";

// ── Cloud: Stripe ───────────────────────────────────────────────────────

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";

export const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID ?? "";

// ── Cloud: Notifications ────────────────────────────────────────────────

export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";

export const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

// ── Cloud: KMS ──────────────────────────────────────────────────────────

export const KMS_KEY_ARN = process.env.KMS_KEY_ARN ?? "";

// ── Cloud: Redis ────────────────────────────────────────────────────────

export const REDIS_HOST = process.env.REDIS_HOST ?? "";

export const REDIS_PORT = process.env.REDIS_PORT ?? "6379";

export const REDIS_USERNAME = process.env.REDIS_USERNAME ?? "";

export const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? "";

// ── Gateway TLS ─────────────────────────────────────────────────────────

export const GATEWAY_CA_CERT = process.env.GATEWAY_CA_CERT ?? "";

export const GATEWAY_CA_PEM_FILE = process.env.GATEWAY_CA_PEM_FILE ?? "";

// ── Logging & Runtime ───────────────────────────────────────────────────

export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const NODE_ENV = process.env.NODE_ENV ?? "development";

export const NEXT_RUNTIME = process.env.NEXT_RUNTIME ?? "";

export const HOME = process.env.HOME ?? "";
