import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { randomUUID } from "crypto";
import { db } from "@onecli/db";
import {
  BETTER_AUTH_BASE_PATH,
  BETTER_AUTH_COOKIE_PREFIX,
  BETTER_AUTH_ID_PREFIX,
  readExternalAuthId,
} from "./better-auth-contract";
import {
  BETTER_AUTH_SECRET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  IS_CLOUD,
} from "./env";
import { logger } from "./logger";
import { configuredApiUrl, configuredAppUrl } from "./app-origin";
import {
  apiOrigin,
  appOrigin,
  buildTrustedOrigins,
  resolveOriginsFromEnv,
} from "./public-origins";
import { resolveCookieDomain } from "./cookie-domain";
import { assertUpgradeWindowClear } from "./registration";
import { sendPasswordResetEmail } from "../services/password-reset-email";

/**
 * The self-hosted identity layer.
 *
 * SERVER-ONLY: this module reaches the database and the auth secret. It must
 * never be imported from a client-reachable module.
 *
 * ONE configuration, built here and shared by every process that resolves a
 * session — the api-server (which mounts the HTTP handler) and the web server
 * (which reads sessions in server components). Both call
 * [`getOnpremAuth`], so the cookie name, the signing secret and the schema
 * mapping cannot drift between them; a mismatch in any of the three reads as
 * "not signed in" on one surface and works on the other, which is exactly the
 * class of bug a single factory removes.
 *
 * The Rust gateway is the third consumer. It cannot import this, so it
 * reimplements the cookie contract (`apps/gateway/crates/context/src/auth.rs`) against the
 * same secret and the same `sessions` table — see [`SESSION_COOKIE_NAMES`].
 *
 * Cloud runs on Cognito and never builds this instance.
 */

export {
  BETTER_AUTH_BASE_PATH,
  BETTER_AUTH_COOKIE_PREFIX,
  SESSION_COOKIE_NAMES,
} from "./better-auth-contract";

/**
 * Sessions live for 30 days and slide: a session used after `updateAge` has
 * its expiry pushed out. Sign-out and revocation DELETE the row, so a
 * withdrawn session stops working everywhere at once — including at the
 * gateway, which reads the same row.
 */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export type OnpremAuth = ReturnType<typeof createOnpremAuth>;

/** A fresh opaque identity for a user better-auth is about to create. */
const newExternalAuthId = (): string =>
  `${BETTER_AUTH_ID_PREFIX}${randomUUID()}`;

export interface OnpremAuthOptions {
  /**
   * The database holding the identity tables. Defaults to the process-wide
   * client; tests that drive a database of their own pass it here.
   */
  prisma?: typeof db;
  /** The signing secret. Also the gateway's HMAC key for the same cookie. */
  secret: string;
  /** This API server's public origin — the base for callback URLs. */
  baseURL: string;
  /** Origins allowed to drive auth requests (the dashboard, on its own host). */
  trustedOrigins?: string[];
  /**
   * `Domain` attribute for every auth cookie (no leading dot), making the
   * session span the domain and all its subdomains. Set when the dashboard
   * and the API live on sibling subdomains of one parent — the only browser
   * mechanism that lets both hosts see the login. Callers resolve it with
   * [`resolveCookieDomain`]; unset issues today's host-only cookie.
   */
  cookieDomain?: string;
  google?: { clientId: string; clientSecret: string };
}

/**
 * Build the instance. Exported for tests, which construct one against a
 * scratch database; production callers want [`getOnpremAuth`].
 */
export const createOnpremAuth = (options: OnpremAuthOptions) => {
  if (!options.secret.trim()) {
    // better-auth would fall back to a well-known development secret, which
    // signs cookies anyone can forge. Refuse instead.
    throw new Error(
      "better-auth requires a secret. Set BETTER_AUTH_SECRET (openssl rand -base64 32).",
    );
  }

  return betterAuth({
    // A falsy `database` makes better-auth silently switch to stateless
    // cookie sessions: it stops writing `sessions` rows, and the gateway —
    // which authenticates by reading them — would reject every browser. The
    // adapter is passed unconditionally so that branch is unreachable.
    database: prismaAdapter(options.prisma ?? db, { provider: "postgresql" }),
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    trustedOrigins: options.trustedOrigins,

    // Opt-in upstream today; pinned off so a future default cannot start
    // reporting a self-hosted deployment's usage.
    telemetry: { enabled: false },

    user: {
      additionalFields: {
        /**
         * The identity every other service resolves a user by (the API
         * middleware and the gateway both look users up on it). It is NOT
         * NULL and unique in our schema, while better-auth creates user rows
         * itself, so `databaseHooks` below stamps it.
         *
         * `input: false` keeps it out of the request-facing API — a client
         * cannot choose or overwrite its own identity — without affecting
         * what is selected or returned, so sessions still carry it.
         */
        externalAuthId: { type: "string", input: false, required: false },
      },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Registration is open on self-host; the ONE refusal left is the
            // pre-2.0 upgrade window (`registration.ts`). This hook is the
            // only place every route that can create a user passes through —
            // the password sign-up and the social callback both reach the
            // adapter here — so a configured Google provider cannot become a
            // way around it.
            //
            // It throws rather than returning `false`; see
            // `signupBlockedByUpgradeError` for why that distinction is
            // load-bearing.
            await assertUpgradeWindowClear(options.prisma ?? db);

            // Merged into the insert (better-auth spreads the returned
            // `data`), which is the only point where a value can reach a
            // column the request-facing API is not allowed to set.
            const existing = readExternalAuthId(user);
            return {
              data: {
                ...user,
                externalAuthId: existing ?? newExternalAuthId(),
              },
            };
          },
          // NOTE: provisioning (organization, workspace, default agent) is
          // deliberately NOT done here. This hook runs once, after the user
          // row has already committed, and a failure inside it is swallowed
          // into a failed sign-in — leaving a real account that can never be
          // provisioned again, because the hook only fires on creation.
          // `GET /v1/auth/session` does it instead, on every session, so a
          // half-provisioned account repairs itself on the next request.
        },
      },
    },

    emailAndPassword: {
      // Registration is open on self-host, so there is nothing for
      // `disableSignUp` to do — and the one refusal that does exist (the
      // pre-2.0 upgrade window) is a per-REQUEST question the user-creation
      // hook above answers, for the social path too, which `disableSignUp`
      // would not have covered at all.
      //
      // Neither `requireEmailVerification` nor `autoSignIn: false` is set,
      // and both must stay unset: either one makes a sign-up for a taken
      // address return 200 with a null token instead of an error, and skips
      // the creation hook entirely — a refusal that looks like a success.
      enabled: true,

      // A password reset is how an account is RECLAIMED. Registration is
      // open and addresses are not verified, so someone could register
      // another person's email before they do; when the real owner proves
      // inbox control by resetting the password, every session the squatter
      // holds must die with the old credential.
      revokeSessionsOnPasswordReset: true,

      // Supplying this is what turns the reset endpoints on at all — without
      // it they answer 400 RESET_PASSWORD_DISABLED. Configured unconditionally
      // rather than only when email is: better-auth answers every request
      // identically ("if this email exists…"), including for addresses that do
      // not exist, and that non-enumeration is worth keeping whatever the mail
      // setup is. Where no provider is configured the send is a no-op, and the
      // dashboard hides the link rather than promising an email nobody can
      // receive.
      sendResetPassword: async ({ user, token }) => {
        await sendPasswordResetEmail({ recipientEmail: user.email, token });
      },
    },

    socialProviders: options.google
      ? {
          google: {
            clientId: options.google.clientId,
            clientSecret: options.google.clientSecret,
          },
        }
      : undefined,

    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // Off: with the cache on, better-auth answers `get-session` from a
      // signed cookie for its lifetime, so a revoked session would keep
      // working there while the gateway (which always reads the row) rejects
      // it. One source of truth is worth the lookup.
      cookieCache: { enabled: false },
    },

    advanced: {
      cookiePrefix: BETTER_AUTH_COOKIE_PREFIX,
      // Spans every auth cookie across `domain` and its subdomains. Upstream
      // adds exactly `{ domain }` to the attributes — sameSite and the cookie
      // NAME are untouched, and sign-out expiry reuses the same attributes,
      // so revocation still clears what sign-in set.
      crossSubDomainCookies: options.cookieDomain
        ? { enabled: true, domain: options.cookieDomain }
        : undefined,
      defaultCookieAttributes: {
        // Pinned, not inherited: the session cookie is a bearer credential the
        // gateway also honours, and "lax" is what keeps another site from
        // driving an authenticated request with it.
        //
        // NEVER add `domain` here: this object spreads AFTER
        // crossSubDomainCookies in upstream's attribute merge, so a domain
        // key in it would silently override `cookieDomain` above.
        sameSite: "lax",
      },
      // Stated rather than derived. better-auth would reach the same answer
      // from `baseURL` today, but its fallback below that is NODE_ENV — which
      // both Docker images bake to "production" while the stock self-host URL
      // is plain HTTP. That combination issues a `__Secure-` cookie the
      // browser then refuses to send back, i.e. a login that never completes.
      // The cookie NAME rides on this and three services have to agree on it,
      // so it is worth one line to not depend on an upstream precedence rule.
      useSecureCookies: options.baseURL.startsWith("https://"),
      database: {
        // Identity rows get real UUIDs like every other table. Without this
        // better-auth mints its own 32-character id format, which nothing
        // else in this database uses.
        generateId: "uuid",
      },
    },

    rateLimit: {
      // Upstream enables this only when NODE_ENV=production; brute-force
      // protection should not depend on how a self-hoster starts the process.
      // Built-in rules already throttle the password endpoints harder than
      // this default.
      enabled: true,
      customRules: {
        // Starting an OAuth redirect carries no secret to guess, so the
        // built-in 3-per-10s rule buys nothing here — and behind a proxy that
        // sends no forwarded-for header every caller shares one bucket, so a
        // stranger hitting this path in a loop could keep everyone else from
        // signing in. Password sign-in keeps the strict default.
        "/sign-in/social": { window: 10, max: 60 },
        // Creating an account is not a secret to guess, and behind a proxy
        // that sends no forwarded-for header every caller shares one bucket —
        // so the built-in default (a handful per ten seconds) is tight enough
        // that a team signing up the same morning, or an operator retrying a
        // rejected password mid-install, could lock the whole instance out of
        // its own signup form.
        "/sign-up/email": { window: 60, max: 10 },
      },
    },

    // Implicit linking (a Google sign-in whose email matches an existing
    // account links instead of refusing) is better-auth's DEFAULT — `enabled`
    // is pinned true here only so the posture is stated, not inherited. The
    // one real knob is `allowDifferentEmails`, which covers the OTHER flow: a
    // LOGGED-IN user clicking "Continue with Google" is attaching that Google
    // identity to their own session's account, where requiring the addresses
    // to match would refuse exactly the case linking exists for.
    //
    // TWO FENCES STAY AT THE LIBRARY DEFAULT, DELIBERATELY (better-auth
    // 1.6.26, oauth2/link-account.mjs):
    //
    // - No `trustedProviders`. Naming a provider there does exactly one
    //   thing: it waives the check that the PROVIDER-side email is verified
    //   (`userInfo.emailVerified`). Real Google sign-ins carry
    //   email_verified: true and link fine without it; the only identities
    //   the waiver admits are ones whose inbox ownership Google explicitly
    //   did NOT vouch for — which is an account-takeover path against any
    //   verified local account. Adding a provider to that list must fail the
    //   posture test first.
    //
    // - `requireLocalEmailVerified` stays true, so implicit linking still
    //   refuses when the EXISTING account's email is unverified — the common
    //   state on a stock self-host, where no email service runs.
    //   Registration is open on self-host, so an attacker can pre-register a
    //   victim's address with a password and wait; refusing unverified-local
    //   links is what keeps that squatter account from absorbing the
    //   victim's Google identity. The refused case gets actionable copy
    //   instead (auth-errors.ts): sign in with the password.
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
      },
    },

    onAPIError: {
      // Where a failed OAuth callback sends the browser. The default is
      // `${baseURL}/error` — this API's own origin, which serves JSON and has
      // no such route, so a refused social sign-up would end on a 404 instead
      // of a page that explains itself. The dashboard's login screen reads the
      // `?error=` it arrives with.
      errorURL: `${appOrigin()}/auth/login`,
    },
  });
};

let cached: OnpremAuth | undefined;

/**
 * The process-wide instance, built on first use.
 *
 * Lazy because constructing it reads the environment and touches the database
 * client: cloud never calls this, and a module-load-time build would run on
 * every import path regardless of edition.
 */
export const getOnpremAuth = (): OnpremAuth => {
  if (IS_CLOUD) {
    throw new Error(
      "better-auth is the self-hosted identity layer; cloud authenticates with Cognito.",
    );
  }
  if (!cached) {
    const cookie = resolveCookieDomain({
      override: process.env.BETTER_AUTH_COOKIE_DOMAIN,
      appUrl: configuredAppUrl(),
      apiUrl: configuredApiUrl(),
    });
    for (const warning of cookie.warnings) logger.warn(warning);
    if (cookie.kind === "shared") {
      logger.info(
        { domain: cookie.domain, source: cookie.source },
        "session cookie spans a shared parent domain — the dashboard, API " +
          "and gateway hosts under it all see the login",
      );
    } else if (cookie.reason === "cross-site") {
      logger.warn(
        { dashboard: configuredAppUrl(), api: configuredApiUrl() },
        "APP_URL and API_URL share no registrable parent domain — no cookie " +
          "can span them, so the dashboard's server-rendered pages cannot " +
          "see a session. Serve both behind one origin (a reverse proxy; " +
          "`pnpm dev` does this automatically), or move them onto sibling " +
          "subdomains of one domain.",
      );
    }

    cached = createOnpremAuth({
      secret: BETTER_AUTH_SECRET,
      baseURL: apiOrigin(),
      trustedOrigins: trustedOrigins(),
      cookieDomain: cookie.kind === "shared" ? cookie.domain : undefined,
      google:
        GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
          ? {
              clientId: GOOGLE_CLIENT_ID,
              clientSecret: GOOGLE_CLIENT_SECRET,
            }
          : undefined,
    });
    logger.info(
      {
        basePath: BETTER_AUTH_BASE_PATH,
        google: Boolean(GOOGLE_CLIENT_ID),
        cookieDomain: cookie.kind === "shared" ? cookie.domain : "host-only",
      },
      "self-host identity layer initialized",
    );
  }
  return cached;
};

/**
 * The dashboard drives auth from its own origin, which is a different port
 * (and possibly host) from this API, so it has to be trusted explicitly:
 * better-auth checks Origin on the sign-in and sign-up POSTs (any browser
 * request — `Sec-Fetch-*` forces the check even without a cookie) and on
 * every cookie-bearing POST and redirect target. The API's own origin is
 * trusted implicitly from `baseURL`.
 *
 * The set comes from the resolver: the app origin plus its loopback twin
 * (an operator typing 127.0.0.1 where the config says localhost must not
 * face an unexplainable 403), any `ONECLI_TRUSTED_ORIGINS` extras, and the
 * api origin when the two live on different hosts. Unconfigured deployments
 * trust the localhost defaults — a prebuilt image cannot know its address,
 * so the zero-config install must still let its own dashboard sign in — and
 * the warning says out loud that any other address will be refused
 * (the symptom is a 403 INVALID_ORIGIN on sign-in with no obvious cause,
 * proven live against this exact configuration).
 *
 * DEV_TRUST_ANY_AUTH_ORIGIN=1 trusts every origin instead. It exists for
 * `pnpm dev`, where the browser may sit on any origin — localhost, or an
 * ad-hoc tunnel whose hostname nobody can list in advance — and it is a
 * deliberate hole: it also lifts better-auth's origin allowlisting of
 * absolute callbackURL/redirectTo values (a dev-only open-redirect surface;
 * SameSite=Lax still keeps cross-site POSTs cookie-less). Three fences keep
 * it out of production: the flag ships only in `.env.dev`, which nothing but
 * the `pnpm dev` launchers load; the NODE_ENV guard below (read at CALL time
 * so tests can prove it) ignores it in any production-configured process;
 * and the loud log line makes an escape visible. Exported for those tests.
 */
export const trustedOrigins = (): string[] => {
  if (
    process.env.DEV_TRUST_ANY_AUTH_ORIGIN === "1" &&
    process.env.NODE_ENV !== "production"
  ) {
    logger.warn(
      "DEV_TRUST_ANY_AUTH_ORIGIN=1 — better-auth trusts EVERY origin. This " +
        "is a development convenience (pnpm dev behind any hostname) and " +
        "must never be set in production.",
    );
    return ["*"];
  }
  const resolved = resolveOriginsFromEnv();
  const { origins, warnings } = buildTrustedOrigins(
    resolved,
    process.env.ONECLI_TRUSTED_ORIGINS,
  );
  for (const warning of warnings) logger.warn(warning);
  if (!resolved.externalConfigured) {
    logger.warn(
      "ONECLI_EXTERNAL_URL is not set — only the localhost defaults are " +
        "trusted, so sign-in from any other address will be refused as an " +
        "untrusted origin. Set ONECLI_EXTERNAL_URL (or legacy APP_URL) to " +
        "the URL users browse to.",
    );
  }
  return origins;
};

/*
 * The session cookie is issued for the host that answered the request, and
 * browsers scope cookies by host rather than by port. The supported shapes,
 * decided by [`resolveCookieDomain`] at boot:
 *
 * - one hostname (ports may differ — the stock compose layout, and `pnpm dev`
 *   behind its single-origin rewrites): host-only cookie, nothing to decide;
 * - sibling subdomains of one parent (`onecli.example.com` +
 *   `api.onecli.example.com`): the cookie spans the shared parent, derived
 *   automatically or pinned/disabled via BETTER_AUTH_COOKIE_DOMAIN;
 * - hosts with no shared registrable parent (localhost + a tunnel, two
 *   unrelated domains): no cookie can span them — the boot warning says to
 *   put one origin in front, which is exactly what `pnpm dev` does.
 */
