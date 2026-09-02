/**
 * Centralized environment variable access.
 *
 * All `process.env` reads should go through this file so that defaults,
 * fallbacks, and naming are managed in one place. Import from `@/lib/env`
 * instead of reading `process.env` directly.
 *
 * NEXT_PUBLIC_* vars are inlined at build time by Next.js — they work on
 * both client and server as long as the literal string appears in source.
 *
 * `NEXT_RUNTIME` is deliberately NOT re-exported here: it must be read as the
 * literal `process.env.NEXT_RUNTIME` at its call-site so Next.js can inline it
 * per-runtime and dead-code-eliminate runtime-specific branches.
 */

import { capabilitiesFor, parseEdition } from "@onecli/api/lib/edition";

// ── App URLs ────────────────────────────────────────────────────────────
//
// The URL exports moved to the shared resolver —
// `@onecli/api/lib/public-origins` (`appOrigin()` / `apiOrigin()` /
// `gatewayHttpOrigin()`). It is client-safe (a leaf module whose
// `NEXT_PUBLIC_*` reads stay literal, so the build-time bakes keep working
// as the browser fallback) and, unlike the constants that used to live here,
// it can tell a configured URL from a defaulted one.

// ── Version ─────────────────────────────────────────────────────────────

/**
 * Build-time app version (e.g. `"1.38.0+f6cca6e5"`), shown in the UI and reported
 * by `/v1/health`. Injected as `NEXT_PUBLIC_APP_VERSION` in `next.config.js`;
 * `"dev"` for local/unstamped builds.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

// ── Edition ─────────────────────────────────────────────────────────────

/** Parsed build edition (single source of truth). */
export const EDITION_INFO = parseEdition(process.env.NEXT_PUBLIC_EDITION);

/** Capability set derived from the current edition. */
export const CAPS = capabilitiesFor(EDITION_INFO);

/** Convenience flag for cloud-specific logic. */
export const IS_CLOUD = EDITION_INFO.edition === "cloud";

// ── Auth & Encryption ───────────────────────────────────────────────────

// The session secret is deliberately NOT re-exported here: nothing in the
// dashboard reads its value. The server side reaches it through the identity
// layer's own config (`@onecli/api/lib/env`), and whether it is configured at
// all is answered by `@onecli/api/lib/session-secret`.

export const SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "";

/**
 * Whether a Google sign-in button should be offered. Read server-side and
 * passed to the login screens as a prop — the value itself never reaches the
 * browser.
 */
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

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

// The server-only cloud vars (Stripe, Resend, Discord, KMS, Redis, gateway
// TLS) are deliberately NOT re-exported here: nothing in the dashboard reads
// them — the live reads are in `@onecli/api`, which the web server process
// executes through the edition defaults and server actions.

// ── Logging & Runtime ───────────────────────────────────────────────────

export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const NODE_ENV = process.env.NODE_ENV ?? "development";
