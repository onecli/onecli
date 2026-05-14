import { Hono } from "hono";
import { db } from "@onecli/db";
import { getSessionProvider } from "../providers";
import { logger } from "../lib/logger";
import {
  findUserDefaultProject,
  bootstrapOrganization,
  ensureProjectSeeds,
} from "../services/organization-service";

/** Extra attributes to spread into the user upsert (create + update). */
export type SessionAttributes = Record<string, unknown>;

export interface SessionHooks {
  getSessionAttributes(request: Request): SessionAttributes;
  onUserCreated(
    user: { email: string; name: string | null },
    attributes: SessionAttributes,
  ): void;
  shouldBootstrapOrg(request: Request): boolean;
  augmentSessionResponse(userId: string): Promise<Record<string, unknown>>;
}

const defaultHooks: SessionHooks = {
  getSessionAttributes: () => ({}),
  onUserCreated: () => {},
  shouldBootstrapOrg: () => true,
  augmentSessionResponse: async () => ({}),
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
        select: { id: true },
      });

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
        const result = await bootstrapOrganization(
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
        { err, route: "GET /api/auth/session" },
        "session sync failed",
      );
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
};
