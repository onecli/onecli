import { Hono } from "hono";
import { db } from "@onecli/db";
import { getSessionProvider } from "../providers";
import type { SessionUser } from "../providers/types";
import { logger } from "../lib/logger";
import {
  findUserDefaultProject,
  bootstrapOrganization,
  joinSharedOrganization,
  ensureProjectSeeds,
} from "../services/organization-service";
import { CAPS } from "../lib/env";

/** Extra attributes to spread into the user upsert (create + update). */
export type SessionAttributes = Record<string, unknown>;

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
  onUserCreated(
    user: { email: string; name: string | null },
    attributes: SessionAttributes,
  ): void;
  shouldBootstrapOrg(request: Request): boolean;
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
}

const defaultHooks: SessionHooks = {
  getSessionAttributes: () => ({}),
  onUserCreated: () => {},
  shouldBootstrapOrg: () => true,
  augmentSessionResponse: async () => ({}),
  resolveIdentityConflict: () => "link",
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
 * 3. Ensures the user has an Organization + Project + ApiKey + Agent
 * 4. Returns the user profile with projectId
 *
 * Called by the login page after auth and by the dashboard layout on mount.
 * Returns 401 if no valid session exists.
 */
export const authSessionRoutes = () => {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      const session = getSessionProvider();
      const user = await session.getSession(c.req.raw);
      if (!user || !user.email) {
        return c.json({ error: "Not authenticated" }, 401);
      }

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

      let defaultProject = await findUserDefaultProject(dbUser.id);

      if (
        !defaultProject &&
        !existingUser &&
        _hooks.shouldBootstrapOrg(c.req.raw)
      ) {
        const result =
          CAPS.tenancy === "single-org-shared"
            ? await joinSharedOrganization(dbUser.id, dbUser.email)
            : await bootstrapOrganization(
                dbUser.id,
                dbUser.email,
                dbUser.name ?? undefined,
              );
        defaultProject = result.project;
        _hooks.onUserCreated({ email: dbUser.email, name: dbUser.name }, extra);
      }

      if (defaultProject) {
        const projectId = defaultProject.id;

        await ensureProjectSeeds(projectId, dbUser.id, dbUser.email);

        return c.json({
          id: dbUser.id,
          email: dbUser.email,
          name: dbUser.name,
          projectId,
          organizationId: defaultProject.organizationId,
        });
      }

      const responseExtra = await _hooks.augmentSessionResponse(dbUser.id);

      return c.json({
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        ...responseExtra,
      });
    } catch (err) {
      logger.error(
        { err, route: "GET /v1/auth/session" },
        "session sync failed",
      );
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
};
