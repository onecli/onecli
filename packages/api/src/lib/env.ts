/**
 * Centralized environment variable access for the API package.
 *
 * Reads both `X` and `NEXT_PUBLIC_X` variants so this works in both
 * Next.js (where build-time NEXT_PUBLIC_ prefix is required) and
 * standalone Node.js (where plain env vars are used).
 */

import { capabilitiesFor, parseEdition } from "./edition";
import { isEntitled } from "./entitlements";
import { firstConfigured, gatewayHttpOrigin } from "./public-origins";

// ── App URLs ────────────────────────────────────────────────────────────
//
// The public URLs live in `public-origins.ts` (the one resolver): use
// `appOrigin()` / `apiOrigin()` / `gatewayHttpOrigin()` / `agentProxyAddress()`
// for advertise-plane values, and `configuredAppUrl()` / `configuredApiUrl()`
// (via `lib/app-origin.ts`) when "was anything configured?" matters. The old
// module-load constants were deleted deliberately: they defaulted to
// localhost, so no caller could tell configured from defaulted.

/**
 * Server-side address of the gateway (cache flushes): an explicit internal
 * override for layouts where the public URL isn't routable from this process
 * (the self-host compose points it at the gateway service), else the public
 * URL — which is exactly right on cloud and in single-host layouts.
 */
export const getGatewayInternalUrl = (): string =>
  firstConfigured(process.env.GATEWAY_INTERNAL_URL) ?? gatewayHttpOrigin();

// ── Edition ─────────────────────────────────────────────────────────────

/** Parsed build edition + variant (single source of truth). */
export const EDITION_INFO = parseEdition(
  process.env.EDITION ?? process.env.NEXT_PUBLIC_EDITION,
);

/**
 * Capability set derived from the current edition + entitlement. Evaluated at
 * module load: server processes have their env at boot, and the entitlement
 * flag cannot change mid-process (same contract as the edition itself).
 */
export const CAPS = capabilitiesFor(EDITION_INFO, { entitled: isEntitled() });

/** Convenience flag for cloud-specific logic. */
export const IS_CLOUD = EDITION_INFO.edition === "cloud";

// ── Auth & Encryption ───────────────────────────────────────────────────

/**
 * Signs self-hosted session cookies (better-auth), and is the HMAC key the
 * gateway verifies them with. Required on a self-hosted deployment — without
 * it nobody can sign in. Unset on cloud, which authenticates with Cognito.
 */
export const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "";

// UNSUBSCRIBE_TOKEN_SECRET is deliberately NOT exported here: the
// unsubscribe-token service reads it at call time and FAILS CLOSED when
// empty (an HMAC keyed by "" is forgeable — anyone could mint unsubscribe
// links). Empty ⇒ no tokens are minted, outgoing mail omits the
// List-Unsubscribe headers, and no token verifies. Set a real value in any
// deployment that sends email; rotating it invalidates live links.

export const SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "";

/** Shared secret the gateway presents to the internal `/v1/internal/*` endpoints. */
export const GATEWAY_INTERNAL_SECRET =
  process.env.GATEWAY_INTERNAL_SECRET ?? "";

export const OAUTH_STATE_SECRET = process.env.OAUTH_STATE_SECRET ?? "";

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

// ── Cloud: Cognito ──────────────────────────────────────────────────────

export const COGNITO_CLIENT_ID =
  process.env.COGNITO_CLIENT_ID ??
  process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ??
  "";

// COGNITO_DOMAIN is deliberately not exported here: nothing in this package
// reads it (the web app has its own live copy in apps/web/src/lib/env.ts).

export const COGNITO_USER_POOL_ID =
  process.env.COGNITO_USER_POOL_ID ??
  process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ??
  "";

// ── Cloud: Stripe ───────────────────────────────────────────────────────

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";

export const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID ?? "";

// ── Cloud: Notifications ────────────────────────────────────────────────

export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";

// The Resend webhook signing secrets (svix `whsec_…`, one PER ENDPOINT from
// the Resend dashboard) are deliberately not exported here: the intake reads
// them at call time and FAILS CLOSED — unset ⇒ that route rejects everything,
// so deployments that never configure them (all self-hosts by default) expose
// no unauthenticated write surface.
//   RESEND_WEBHOOK_SECRET          → POST /v1/webhooks/resend
//   RESEND_INBOUND_WEBHOOK_SECRET  → POST /v1/webhooks/inbound
// Each accepts a whitespace/comma separated list, so a rotation can keep the
// old secret valid alongside the new one.

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

// ── Runner plane (hosted agents) ────────────────────────────────────────

/**
 * The instance registration anchor for the runner plane (§5.1): a runner
 * presenting exactly this `rnr_` token may create its Runner row. Empty =
 * registration of new runners is impossible (cloud's posture — the hosted
 * surface stays dark, invariant 13). install.sh generates it into the
 * self-host `.env` shared by the api and runner services.
 */
export const RUNNER_TOKEN = process.env.RUNNER_TOKEN ?? "";

/**
 * The channel adapter's registration anchor (step 6) — the `cha_` twin of
 * `RUNNER_TOKEN`, with identical semantics: presenting exactly this token may
 * create the ChannelAdapter row; empty means no adapter can ever register.
 */
export const CHANNEL_ADAPTER_TOKEN = process.env.CHANNEL_ADAPTER_TOKEN ?? "";

// ── SSH front door (plans/sandbox-platform.md step 5) ─────────────────────

/**
 * The terminator's service secret — the narrow terminator↔control-plane
 * channel (§3.8's pre-authorized fallback). Presenting exactly this value
 * authorizes `/v1/ssh-terminator/*` and NOTHING else; empty means the
 * surface refuses everything (the RUNNER_TOKEN dark posture). Never the
 * runner↔manager secret, never a DB token family — one credential per plane.
 */
export const SSH_TERMINATOR_SECRET = process.env.SSH_TERMINATOR_SECRET ?? "";

/**
 * KMS asymmetric CA key (cloud): when set, `ensureEditionDefaults()` injects
 * the KMS-backed signer. Onprem signs in-process with SSH_CA_PRIVATE_KEY
 * instead. Neither set = the whole SSH surface is dark.
 */
export const SSH_CA_KMS_KEY_ARN = process.env.SSH_CA_KMS_KEY_ARN ?? "";

/** Onprem CA: an ed25519 PKCS#8 PEM private key. Unset = surface dark. */
export const SSH_CA_PRIVATE_KEY = process.env.SSH_CA_PRIVATE_KEY ?? "";

/** Public SSH endpoint host (e.g. `ssh-dev.onecli.sh`). Unset = surface dark. */
export const SSH_HOST = process.env.SSH_HOST ?? "";

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Public SSH endpoint PORT. Default 22 — cloud fronts the terminator with an
 * NLB on :22, so the advertised port and the generated connect command stay
 * exactly as before. Self-host publishes an unprivileged high port instead
 * (a default-on listener cannot bind :22), which the client honors via
 * `ssh -p`.
 */
export const SSH_PORT = positiveInt(process.env.SSH_PORT, 22);

/** Minted certificate lifetime — gates NEW auth only, never live sessions. */
export const SSH_CERT_TTL_SECONDS = positiveInt(
  process.env.SSH_CERT_TTL_SECONDS,
  600,
);

/** Per-(user, agent) mint budget per hour (anti-abuse, fail-closed on DB error). */
export const SSH_CERT_MINTS_PER_HOUR = positiveInt(
  process.env.SSH_CERT_MINTS_PER_HOUR,
  30,
);

/**
 * Concurrent lease-current sessions per agent.
 *
 * Sized from real client behaviour, not a round number: one editor session
 * (VS Code Remote opens the server bootstrap plus a probe connection, and
 * without ControlMaster each window adds one), one or two hand terminals, and
 * a transient `scp`/`sftp` already reaches five. The earlier ceiling of 3
 * refused a single developer mid-workflow on the dev live gate. Each session
 * costs one ServiceAccount/Role/RoleBinding plus one exec stream, so the real
 * protections are the terminator's global and per-IP caps — this one only
 * stops one agent from being used as an unbounded fan-out.
 */
export const SSH_MAX_SESSIONS_PER_AGENT = positiveInt(
  process.env.SSH_MAX_SESSIONS_PER_AGENT,
  8,
);

/** Hard ceiling on one session; also bounds the broker grant's lifetime. */
export const SSH_MAX_SESSION_SECONDS = positiveInt(
  process.env.SSH_MAX_SESSION_SECONDS,
  43200,
);

/** Terminator-enforced idle timeout, returned in the session policy. */
export const SSH_IDLE_TIMEOUT_SECONDS = positiveInt(
  process.env.SSH_IDLE_TIMEOUT_SECONDS,
  1800,
);

/**
 * The session lease: a session whose last heartbeat is older than this is
 * treated as dead by every consumer (keep-awake, start dueness, the cap) and
 * closed by the stale-session sweep. 3× the terminator's 30s heartbeat.
 */
export const SSH_SESSION_LEASE_SECONDS = positiveInt(
  process.env.SSH_SESSION_LEASE_SECONDS,
  90,
);

/** A runner whose last heartbeat is older than this is offline (§3.13). */
export const RUNNER_ONLINE_THRESHOLD_SECONDS = positiveInt(
  process.env.RUNNER_ONLINE_THRESHOLD_SECONDS,
  90,
);

/** Idle window after which a running sandbox is parked (§3.9 sleep). */
export const SANDBOX_IDLE_STOP_SECONDS = positiveInt(
  process.env.SANDBOX_IDLE_STOP_SECONDS,
  1800,
);

/**
 * Wall-clock backstop on a single turn, from when it was posted. Liveness is
 * the stall clock below (a wedged turn dies in minutes, not hours); this
 * bound only exists so a live-but-runaway agent cannot burn tokens forever,
 * so it is generous — long supervision turns are legitimate. Both together
 * are what guarantee a conversation always recovers (the active-turn index
 * makes a stuck non-terminal turn a permanently blocked conversation).
 */
export const TURN_CEILING_SECONDS = positiveInt(
  process.env.TURN_CEILING_SECONDS,
  21600,
);

/**
 * How long before the ceiling the in-flight warning steers into the live
 * run (`claimDueWork`'s approaching-ceiling arm): enough runway for the
 * agent to stop waiting, summarize supervised work, and close the turn
 * cleanly — instead of dying mid-sleep with no handoff. Generous because
 * steers inject only at safe points between tool rounds, and a long tool
 * call (a swarm await, a bg wait) can defer consumption by many minutes.
 */
export const TURN_CEILING_WARNING_SECONDS = positiveInt(
  process.env.TURN_CEILING_WARNING_SECONDS,
  900,
);

/**
 * The liveness clock: a RUNNING turn whose supervisor stopped stamping
 * progress (`turns.last_progress_at`, heartbeat ~60s) for this long is
 * wedged — its sandbox died, wedged silently, or lost its channel — and is
 * failed as `turn_stalled` so the conversation unblocks in minutes instead
 * of waiting out the ceiling. Turns from agent images that predate the
 * heartbeat never stamp the clock and stay under the ceiling alone.
 */
export const TURN_STALL_SECONDS = positiveInt(
  process.env.TURN_STALL_SECONDS,
  600,
);

/**
 * Operator override for the per-runner held-awake ceiling (§3.9 / step 13):
 * how many sandboxes live background work may hold out of idle-stop at once.
 * Unset/invalid = null = the derived default, `max(1, maxSandboxes − 1)` per
 * runner — which always leaves one slot free for interactive turns and needs
 * no operator input. There is deliberately NO "unlimited" spelling: the
 * ceiling exists because unbounded keep-awake is a legitimate-usage path to
 * wedging the host (plans/v2-todo.md, release blocker).
 */
const optionalPositiveInt = (raw: string | undefined): number | null => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const MAX_HELD_AWAKE_SANDBOXES = optionalPositiveInt(
  process.env.MAX_HELD_AWAKE_SANDBOXES,
);

// ── Logging & Runtime ───────────────────────────────────────────────────

export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const NODE_ENV = process.env.NODE_ENV ?? "development";

export const HOME = process.env.HOME ?? "";
