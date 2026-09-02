import { Hono } from "hono";
import { db } from "@onecli/db";
import {
  getSessionProvider,
  getSessionEnforcer,
  getSessionThrottle,
} from "../providers";
import type { SessionUser } from "../providers/types";
import { withLegacyProjectId } from "../lib/legacy-project-compat";
import { logger } from "../lib/logger";
import {
  findUserDefaultWorkspace,
  ensureUserOrganization,
  ensureWorkspaceSeeds,
} from "../services/organization-service";

/** Extra attributes to spread into the user upsert (create + update). */
type SessionAttributes = Record<string, unknown>;

/** The DB user a conflicting session's email already belongs to. */
export interface ExistingIdentity {
  id: string;
  email: string;
  externalAuthId: string;
}

/** Single user-facing message for a rejected identity relink (409). */
export const IDENTITY_CONFLICT_ERROR =
  "This email is already associated with a different sign-in identity. Sign in with your original method.";

export interface SessionHooks {
  getSessionAttributes(request: Request): SessionAttributes;
  /**
   * Reconcile pre-existing rows with this session's identity, before the user
   * row is resolved at all.
   *
   * Runs first because an edition may need to decide WHICH row this session
   * belongs to — the self-hosted upgrade path hands a pre-2.0 deployment's
   * data to the account that just registered, which changes what the lookup
   * below finds. Runs on every session, so it must be idempotent.
   *
   * Unlike `ensureSessionMembership`, a failure here is NOT best-effort: it
   * propagates. Continuing past a failed reconciliation would provision a
   * fresh empty organization and leave the real data stranded behind an
   * identity nothing points at any more — a state no later request could
   * repair. Failing the request keeps it retryable. The default is a no-op.
   */
  beforeIdentitySync(session: SessionUser): Promise<void>;
  /**
   * Fires once when the session upsert created a new user row — for every
   * flow, not just organic signups. `context.bootstrappedOrg` says whether
   * the default org bootstrap ran for this user; editions use it (and the
   * request) to tell organic signups apart from users who join an existing
   * org (invitation, claim link, JIT membership).
   */
  onUserCreated(
    user: { email: string; name: string | null },
    attributes: SessionAttributes,
    context: { request: Request; bootstrappedOrg: boolean },
  ): void;
  /**
   * Whether a user with no organization should be given one now.
   *
   * `context.isNewUser` says whether THIS request created the user row.
   * Editions differ on whether that matters: where the identity layer creates
   * the row before this endpoint ever sees it, requiring it would mean a user
   * whose provisioning failed could never be repaired.
   */
  shouldBootstrapOrg(
    request: Request,
    context: { isNewUser: boolean },
  ): boolean;
  augmentSessionResponse(userId: string): Promise<Record<string, unknown>>;
  /**
   * Decide what happens when a session's email already belongs to a user with
   * a DIFFERENT auth identity (`externalAuthId` mismatch): "link" re-points
   * the user to the session's identity; "reject" refuses the sign-in (409).
   * The default preserves the historical behavior (always link) — editions
   * with untrusted identity sources override this with a real policy.
   */
  resolveIdentityConflict(
    existing: ExistingIdentity,
    session: SessionUser,
  ): "link" | "reject" | Promise<"link" | "reject">;
  /**
   * Ensure edition-specific org membership for the session's identity (e.g.
   * enterprise-SSO JIT join) before the default org-bootstrap decision. Runs
   * on every session and must be idempotent and non-throwing — membership is
   * best-effort; session resolution is not. The default is a no-op.
   */
  ensureSessionMembership(
    session: SessionUser,
    user: { id: string; email: string; name: string | null },
  ): Promise<void>;
}

const defaultHooks: SessionHooks = {
  getSessionAttributes: () => ({}),
  beforeIdentitySync: async () => {},
  onUserCreated: () => {},
  // Only a user this request created — the historical behavior, kept as the
  // default so an edition that does not opt in is unaffected.
  shouldBootstrapOrg: (_request, { isNewUser }) => isNewUser,
  augmentSessionResponse: async () => ({}),
  resolveIdentityConflict: () => "link",
  ensureSessionMembership: async () => {},
};

let _hooks: SessionHooks = defaultHooks;

export const initSessionHooks = (hooks: Partial<SessionHooks>) => {
  _hooks = { ...defaultHooks, ...hooks };
};

/**
 * GET /auth/session
 *
 * Single endpoint that handles the full auth -> DB sync flow:
 * 1. Reads the auth session (cookie/token)
 * 2. Upserts the user in the database
 * 3. Ensures the user has an Organization + Workspace + ApiKey + Agent
 * 4. Returns the user profile with workspaceId
 *
 * Called by the login page after auth and by the dashboard layout on mount.
 * Returns 401 if no valid session exists.
 */
export const authSessionRoutes = () => {
  const app = new Hono();

  // Edition throttle (cloud: per-IP Redis limiter) ahead of the handler, so
  // a 429 precedes the session read and every bootstrap DB write. Resolved
  // at call time like every provider slot; the onprem default is null.
  app.get(
    "/",
    async (c, next) => {
      const throttle = getSessionThrottle();
      if (throttle) return throttle(c, next);
      await next();
    },
    async (c) => {
      try {
        const session = getSessionProvider();
        const user = await session.getSession(c.req.raw);
        if (!user || !user.email) {
          return c.json({ error: "Not authenticated" }, 401);
        }

        // Before anything reads a user row: an edition may still be deciding
        // which row this identity owns (see the hook's contract).
        await _hooks.beforeIdentitySync(user);

        const extra = _hooks.getSessionAttributes(c.req.raw);

        const existingUser = await db.user.findUnique({
          where: { email: user.email },
          select: { id: true, email: true, externalAuthId: true },
        });

        if (existingUser && existingUser.externalAuthId !== user.id) {
          const decision = await _hooks.resolveIdentityConflict(
            existingUser,
            user,
          );
          if (decision === "reject") {
            return c.json({ error: IDENTITY_CONFLICT_ERROR }, 409);
          }
        }

        const dbUser = await db.user.upsert({
          where: { email: user.email },
          create: {
            externalAuthId: user.id,
            email: user.email,
            name: user.name,
            lastLoginAt: new Date(),
            ...extra,
          },
          update: {
            externalAuthId: user.id,
            name: user.name,
            lastLoginAt: new Date(),
            ...extra,
          },
          select: { id: true, email: true, name: true },
        });

        // Edition membership (e.g. SSO JIT join) runs before the default
        // workspace resolution so a just-created membership's workspace is what
        // the session lands on — and the bootstrap branch below self-skips.
        await _hooks.ensureSessionMembership(user, dbUser);

        // Edition session policy (e.g. enterprise "require SSO") — after JIT
        // so a first SSO login joins and then trivially passes. Denials MUST
        // return inline: a throw would land in the catch below as a 500.
        const enforcer = getSessionEnforcer();
        if (enforcer) {
          const denial = await enforcer(user, dbUser);
          if (denial) {
            return c.json({ error: denial.error, code: denial.code }, 401);
          }
        }

        let defaultWorkspace = await findUserDefaultWorkspace(dbUser.id);

        // `created` (not "the gate passed") feeds `onUserCreated`: a sync that
        // converged on a concurrent winner's org, or repaired a half-provisioned
        // one, must not re-announce the signup.
        let bootstrappedOrg = false;
        if (
          !defaultWorkspace &&
          _hooks.shouldBootstrapOrg(c.req.raw, { isNewUser: !existingUser })
        ) {
          const result = await ensureUserOrganization(
            dbUser.id,
            dbUser.email,
            dbUser.name ?? undefined,
          );
          defaultWorkspace = result.workspace;
          bootstrappedOrg = result.created;
        }

        // No user row existed for this email before the upsert → it was created
        // by this request. Fires outside the bootstrap branch so non-bootstrap
        // signups (invitation/claim flows) reach the hook too.
        if (!existingUser) {
          _hooks.onUserCreated(
            { email: dbUser.email, name: dbUser.name },
            extra,
            { request: c.req.raw, bootstrappedOrg },
          );
        }

        if (defaultWorkspace) {
          const workspaceId = defaultWorkspace.id;

          await ensureWorkspaceSeeds(workspaceId, dbUser.id, dbUser.email);

          // `withLegacyProjectId` dual-emits `projectId` (rename compat, temporary).
          return c.json(
            withLegacyProjectId({
              id: dbUser.id,
              email: dbUser.email,
              name: dbUser.name,
              workspaceId,
              organizationId: defaultWorkspace.organizationId,
            }),
          );
        }

        const responseExtra = await _hooks.augmentSessionResponse(dbUser.id);

        const sessionPayload = {
          id: dbUser.id,
          email: dbUser.email,
          name: dbUser.name,
          ...responseExtra,
        };
        return c.json(withLegacyProjectId(sessionPayload));
      } catch (err) {
        logger.error(
          { err, route: "GET /v1/auth/session" },
          "session sync failed",
        );
        return c.json({ error: "Internal server error" }, 500);
      }
    },
  );

  return app;
};
