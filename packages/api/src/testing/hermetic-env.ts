/**
 * Hermetic test environment — normalize the ambient shell env to the clean-CI
 * baseline before any test module loads.
 *
 * The disease this cures: edition and config reads freeze at MODULE LOAD
 * (`lib/env.ts` resolves `EDITION ?? NEXT_PUBLIC_EDITION` once per worker),
 * and turbo passes a developer's shell exports straight into vitest
 * (`turbo.json` `globalPassThroughEnv`). Most suites pin their edition with
 * `NEXT_PUBLIC_EDITION` only, so an ambient `EDITION=cloud` (the documented
 * cloud-dev `.env` block) silently defeats every one of those pins — on a
 * pristine tree the full suite goes from green to dozens of failures, with
 * the exact set depending on whatever else the shell exports.
 *
 * The cure, applied per test file by `hermetic-env.setup.ts` (wired in
 * `vitest.config.ts`), BEFORE the test file's module graph — including its
 * `vi.hoisted` blocks — evaluates:
 *
 *  1. Fold `EDITION` into `NEXT_PUBLIC_EDITION`, preserving production's
 *     precedence (`EDITION` wins), then delete `EDITION`. Per-file
 *     `NEXT_PUBLIC_EDITION` pins become authoritative again, and a shell
 *     with `EDITION=cloud` behaves exactly like CI's cloud lane.
 *  2. Delete every var in `AMBIENT_HAZARD_VARS` — reads that change test
 *     behavior or reach real infrastructure (Prisma at `DATABASE_URL`,
 *     ioredis at `REDIS_HOST`, Resend email sends, Stripe price maps,
 *     app-registry OAuth credentials, …).
 *  3. Pin `NODE_ENV=test` (vitest only defaults it when unset — an exported
 *     `NODE_ENV=production` would otherwise flip logger/cookie branches).
 *  4. Pin `GATEWAY_CA_PEM_FILE` to a nonexistent sentinel so `gateway-ca.ts`
 *     resolves to `null` deterministically instead of reading a dev
 *     machine's `~/.onecli/gateway/ca.pem` (CI has no such file).
 *
 * Deliberately preserved: `NEXT_PUBLIC_EDITION` — CI's lane carrier (the
 * workflow runs the suite once with it set to `cloud` job-wide and once
 * unset, so both editions' module-load paths stay proven); `CI` and
 * `POLICY_PROOF_DATABASE_URL` — `testing/pg-proof.ts`'s opt-in/loud-fail
 * contract; `LOG_LEVEL`, `HOME`, `PATH`.
 *
 * One worker, many files: the setup runs before EVERY test file, but a
 * worker that runs several files (the pg project's `singleFork`, where all
 * of them share one process) also shares `process.env` between them, and
 * vitest restores none of it. Suites pin their edition by writing
 * `process.env` and never undo it, so without a reset the NEXT file loaded
 * under the PREVIOUS file's pin: a suite could pass only because whatever
 * ran before it happened to pin the edition it needed, and fail the day the
 * file order changed. `applyHermeticEnv` closes that: the first file in a
 * worker records the normalized env as the worker's baseline, and every
 * later file starts from exactly that baseline (5. below).
 *
 *  5. Restore the worker baseline before each later file: drop vars a
 *     previous file added, put back ones it changed or deleted. The
 *     runner's own bookkeeping (`VITEST*`, `TEST`) is left to vitest.
 *
 * This module must stay dependency-free: importing anything from `src/`
 * here would freeze `lib/env.ts` before the normalization runs.
 */

/**
 * Env vars deleted before each test file. Every name is read by
 * `packages/api` / `packages/db` production code (or by an SDK's default
 * credential chain); an ambient value changes test behavior.
 * `hermetic-env.test.ts` keeps the list complete two ways: the app-registry
 * credential section is walked against `getApps()`, and every literal
 * `process.env.X` read in production source must classify as either hazard
 * or deliberately preserved — a new env read fails the suite until placed.
 */
export const AMBIENT_HAZARD_VARS: readonly string[] = [
  // Entitlement — flips CAPS.rbac at module load on onprem
  "ENTERPRISE_ENABLED",
  // Platform trial credit — presence flips container-config advertisement
  "PLATFORM_ANTHROPIC_API_KEY",
  // Secrets
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "UNSUBSCRIBE_TOKEN_SECRET",
  "SECRET_ENCRYPTION_KEY",
  "GATEWAY_INTERNAL_SECRET",
  "OAUTH_STATE_SECRET",
  "KMS_KEY_ARN",
  // Cognito
  "COGNITO_CLIENT_ID",
  "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  "COGNITO_DOMAIN",
  "NEXT_PUBLIC_COGNITO_DOMAIN",
  "COGNITO_USER_POOL_ID",
  "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
  // Stripe (lib/env.ts + ee/billing/env.ts)
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_PRO_YEARLY_PRICE_ID",
  "STRIPE_TEAM_BASE_PRICE_ID",
  "STRIPE_TEAM_YEARLY_PRICE_ID",
  "STRIPE_TEAM_LEGACY_199_PRICE_ID",
  "STRIPE_TEAM_LEGACY_199_YEARLY_PRICE_ID",
  "STRIPE_TEAM_LEGACY_PRICE_ID",
  "STRIPE_TEAM_HOSTED_PRICE_ID",
  "STRIPE_TEAM_HOSTED_YEARLY_PRICE_ID",
  "STRIPE_SCALE_PRICE_ID",
  "STRIPE_SCALE_YEARLY_PRICE_ID",
  "STRIPE_SCALE_SELF_HOSTED_PRICE_ID",
  "STRIPE_SCALE_SELF_HOSTED_YEARLY_PRICE_ID",
  "STRIPE_ENTERPRISE_PRICE_ID",
  // AWS Marketplace SaaS listing (ee/billing/aws-marketplace/env.ts) —
  // ambient values would flip the marketplace flows live and aim the real
  // AWS APIs, so tests always clear them.
  "AWS_MARKETPLACE_PRODUCT_CODE",
  "AWS_MARKETPLACE_CONTRACT_DIMENSION",
  "AWS_MARKETPLACE_OVERAGE_DIMENSION",
  "AWS_MARKETPLACE_REGION",
  "AWS_MARKETPLACE_SNS_TOPIC_ARN",
  // Outbound comms
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "RESEND_INBOUND_WEBHOOK_SECRET",
  "DISCORD_WEBHOOK_URL",
  "DISCORD_REVIEW_WEBHOOK_URL",
  "ENVIRONMENT",
  // Stores — ambient values reach real infrastructure
  "REDIS_HOST",
  "REDIS_PORT",
  "REDIS_USERNAME",
  "REDIS_PASSWORD",
  "DATABASE_URL",
  "DB_HOST",
  "DB_USERNAME",
  "DB_PASSWORD",
  "DB_PORT",
  "DB_NAME",
  // URLs / gateway
  "ONECLI_EXTERNAL_URL",
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "API_URL",
  "NEXT_PUBLIC_API_URL",
  "GATEWAY_API_URL",
  "NEXT_PUBLIC_GATEWAY_API_URL",
  "GATEWAY_INTERNAL_URL",
  "API_INTERNAL_URL",
  "GATEWAY_BASE_URL",
  "ONECLI_AGENT_PROXY_ADDRESS",
  "ONECLI_TRUSTED_ORIGINS",
  // Publish plane, read only by the resolver's legacy bind seed and the
  // ports-mode derivation (public-origins.ts).
  "ONECLI_BIND_HOST",
  "ONECLI_APP_PORT",
  "ONECLI_API_PORT",
  "ONECLI_GATEWAY_PORT",
  "GATEWAY_CA_CERT",
  // Flags & service tokens
  "DEV_TRUST_ANY_AUTH_ORIGIN",
  "BETTER_AUTH_COOKIE_DOMAIN",
  "MAX_ORGS_PER_USER",
  "RUNNER_TOKEN",
  "CHANNEL_ADAPTER_TOKEN",
  "RUNNER_ONLINE_THRESHOLD_SECONDS",
  "SANDBOX_IDLE_STOP_SECONDS",
  "SANDBOX_BACKGROUND_CAP_SECONDS",
  "TURN_CEILING_SECONDS",
  "TURN_CEILING_WARNING_SECONDS",
  "TURN_STALL_SECONDS",
  "STALE_DISPATCH_SECONDS",
  "MAX_HELD_AWAKE_SANDBOXES",
  "SANDBOX_DEFAULT_TIMEZONE",
  // SSH front door
  "SSH_TERMINATOR_SECRET",
  "SSH_CA_KMS_KEY_ARN",
  "SSH_CA_PRIVATE_KEY",
  "SSH_HOST",
  "SSH_PORT",
  "SSH_CERT_TTL_SECONDS",
  "SSH_CERT_MINTS_PER_HOUR",
  "SSH_MAX_SESSIONS_PER_AGENT",
  "SSH_MAX_SESSION_SECONDS",
  "SSH_IDLE_TIMEOUT_SECONDS",
  "SSH_SESSION_LEASE_SECONDS",
  // Sandbox ports / previews — presence lights the preview routes and the
  // agent's Ports section.
  "PREVIEW_DOMAIN",
  "PREVIEW_RELAY_SECRET",
  // Published egress identity (plans/stable-egress-identity.md) — presence
  // flips GET /v1/instance/egress from 404 to a live feed at module load,
  // and a malformed ambient value throws at import.
  "EGRESS_IPV4_ADDRESSES",
  "EGRESS_REGION",
  // Attachment object storage (plans/agent-owns-its-machine.md tier 3) —
  // presence flips the edition's blob store from Postgres to S3 at module
  // load; an ambient bucket name would send every attachment test at AWS.
  "ATTACHMENTS_S3_BUCKET",
  // Provider base URLs (test doubles point these at fakes per suite)
  "SLACK_API_BASE_URL",
  "SLACK_CDN_BASE_URL",
  "ANTHROPIC_API_BASE_URL",
  "OPENAI_API_BASE_URL",
  // The shared Slack app (deployment config): ambient real credentials would
  // make the shared arm exist inside tests — the routes and posture helpers
  // branch on presence, so these must never leak in from a dev shell.
  "SLACK_SHARED_CLIENT_ID",
  "SLACK_SHARED_CLIENT_SECRET",
  "SLACK_SHARED_SIGNING_SECRET",
  "SLACK_SHARED_APP_ID",
  "SLACK_SHARED_APP_MANAGER_APPROVED",
  // AWS default credential chain — read inside the SDK, not via a literal
  // process.env, so the source-scan guard can't see these; a dev's live AWS
  // credentials must not be reachable from a test process. AWS_REGION stays
  // (non-secret, shared tooling).
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_ENDPOINT_URL_KMS",
  // App-registry OAuth credentials (configurable.envDefaults)
  "ATTIO_CLIENT_ID",
  "ATTIO_CLIENT_SECRET",
  "ATLASSIAN_CLIENT_ID",
  "ATLASSIAN_CLIENT_SECRET",
  "DROPBOX_CLIENT_ID",
  "DROPBOX_CLIENT_SECRET",
  "FATHOM_CLIENT_ID",
  "FATHOM_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "HUBSPOT_CLIENT_ID",
  "HUBSPOT_CLIENT_SECRET",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MONDAY_CLIENT_ID",
  "MONDAY_CLIENT_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "SENTRY_CLIENT_ID",
  "SENTRY_CLIENT_SECRET",
  "SUPABASE_CLIENT_ID",
  "SUPABASE_CLIENT_SECRET",
  "TODOIST_CLIENT_ID",
  "TODOIST_CLIENT_SECRET",
  "TRELLO_API_KEY",
  "TRELLO_API_SECRET",
  "WEBFLOW_CLIENT_ID",
  "WEBFLOW_CLIENT_SECRET",
  "ZOHO_CRM_CLIENT_ID",
  "ZOHO_CRM_CLIENT_SECRET",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
];

/**
 * Nonexistent path pinned into `GATEWAY_CA_PEM_FILE` so the CA loader's
 * file read fails deterministically on every machine (matching CI, which
 * has no `~/.onecli/gateway/ca.pem`). Suites that need a CA set
 * `GATEWAY_CA_CERT` themselves.
 */
export const HERMETIC_CA_PEM_SENTINEL =
  "/nonexistent/onecli-hermetic-tests/ca.pem";

/** Marker asserted by `hermetic-env.test.ts` to prove the setup is wired. */
export const HERMETIC_MARKER_VAR = "ONECLI_TEST_HERMETIC";

/**
 * Production env reads that deliberately survive normalization, each for a
 * stated reason — the classification the source-scan guard checks against:
 * `EDITION` is folded (never survives, but production reads it);
 * `NEXT_PUBLIC_EDITION` is CI's lane carrier; `NODE_ENV` and
 * `GATEWAY_CA_PEM_FILE` are pinned to fixed values; `CI` +
 * `POLICY_PROOF_DATABASE_URL` are the pg proof suites' opt-in/loud-fail
 * contract (`testing/pg-proof.ts`); `LOG_LEVEL` only changes verbosity;
 * `HOME` is too invasive to touch (the CA pem path it feeds is pinned).
 */
export const PRESERVED_AMBIENT_VARS: readonly string[] = [
  "EDITION",
  "NEXT_PUBLIC_EDITION",
  "NODE_ENV",
  "GATEWAY_CA_PEM_FILE",
  "CI",
  "POLICY_PROOF_DATABASE_URL",
  "LOG_LEVEL",
  "HOME",
];

/**
 * Where the worker baseline lives between files: on `globalThis`, because
 * the setup module itself is re-evaluated per file (isolated module
 * registries) while the worker process, and its `process.env`, carry over.
 */
export const HERMETIC_BASELINE_KEY = "__onecliHermeticBaseline";

/** The holder `applyHermeticEnv` keeps the baseline on (`globalThis`). */
export type HermeticBaselineHolder = {
  [HERMETIC_BASELINE_KEY]?: Readonly<Record<string, string>>;
};

/** The worker's holder: `globalThis`, typed the way `@onecli/db`'s Prisma
 * singleton and `providers/edition-state.ts` type theirs. */
export const workerBaselineHolder = (): HermeticBaselineHolder =>
  globalThis as unknown as HermeticBaselineHolder;

/** Vars vitest itself owns and sets per worker; never restored by us. */
const isRunnerOwned = (name: string): boolean =>
  name === "TEST" || name.startsWith("VITEST");

/**
 * The per-file entry point (`hermetic-env.setup.ts`): normalize the first
 * file's env and record it as the worker baseline, then reset every later
 * file in the same worker to that baseline (see module doc, step 5).
 */
export const applyHermeticEnv = (
  env: NodeJS.ProcessEnv,
  holder: HermeticBaselineHolder,
): void => {
  const baseline = holder[HERMETIC_BASELINE_KEY];
  if (baseline === undefined) {
    normalizeTestEnv(env);
    const snapshot: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined && !isRunnerOwned(name)) snapshot[name] = value;
    }
    holder[HERMETIC_BASELINE_KEY] = snapshot;
    return;
  }
  for (const name of Object.keys(env)) {
    if (!isRunnerOwned(name) && !Object.hasOwn(baseline, name)) {
      delete env[name];
    }
  }
  for (const [name, value] of Object.entries(baseline)) env[name] = value;
};

/** Normalize `env` in place to the clean-CI test baseline (see module doc). */
export const normalizeTestEnv = (env: NodeJS.ProcessEnv): void => {
  // Production resolves `EDITION ?? NEXT_PUBLIC_EDITION`, so a set EDITION —
  // empty string included — must overwrite the fallback var, not yield to it.
  if (env.EDITION !== undefined) {
    env.NEXT_PUBLIC_EDITION = env.EDITION;
    delete env.EDITION;
  }

  for (const name of AMBIENT_HAZARD_VARS) {
    delete env[name];
  }

  env.NODE_ENV = "test";
  env.GATEWAY_CA_PEM_FILE = HERMETIC_CA_PEM_SENTINEL;
  env[HERMETIC_MARKER_VAR] = "1";
};
