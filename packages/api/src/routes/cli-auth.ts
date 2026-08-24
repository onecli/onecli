import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { auth, requireWorkspaceId } from "../middleware/auth";
import { getSessionProvider } from "../providers";
import {
  createCliAuthSession,
  pollCliAuthSession,
  confirmCliAuthSession,
} from "../services/cli-auth-service";
import { markOnboardingCompleteForUser } from "../services/onboarding-service";
import { appOrigin, normalizeOrigin } from "../lib/public-origins";
import { trustedOrigins } from "../lib/better-auth";
import { ServiceError } from "../services/errors";
import { withLegacyProjectLists } from "../lib/legacy-project-compat";
import { logger } from "../lib/logger";
import { getUserOrgsWithWorkspaces } from "../ee/services/workspace-service";

export const cliAuthRoutes = () => {
  const app = new Hono<ApiEnv>();

  // POST /session
  app.post("/session", async (c) => {
    try {
      const result = await createCliAuthSession(appOrigin());
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "cli auth session creation failed");
      return c.json({ error: "Failed to create session" }, 500);
    }
  });

  // GET /poll
  app.get("/poll", async (c) => {
    const code = c.req.query("code");
    if (!code) {
      return c.json({ error: "Missing code" }, 400);
    }

    try {
      const result = await pollCliAuthSession(code);
      return c.json(result);
    } catch (err) {
      if (err instanceof ServiceError && err.code === "NOT_FOUND") {
        return c.json({ status: "expired" });
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // GET /options — the user's orgs + workspaces, so the confirm screen can let
  // them choose which workspace to connect the CLI to. Authenticates the user
  // inline: no workspace/org context exists yet, so the shared auth() middleware
  // (which requires one) can't be used here.
  app.get("/options", async (c) => {
    const sessionUser = await getSessionProvider().getSession(c.req.raw);
    if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);

    const dbUser = await db.user.findUnique({
      where: { externalAuthId: sessionUser.id },
      select: { id: true },
    });
    if (!dbUser) return c.json({ error: "Unauthorized" }, 401);

    // `withLegacyProjectLists` dual-emits each org's workspaces under the
    // legacy `projects` key (rename compat, temporary).
    const organizations = await getUserOrgsWithWorkspaces(dbUser.id);
    return c.json({ organizations: withLegacyProjectLists(organizations) });
  });

  // POST /confirm — bind the terminal to the chosen workspace (X-Workspace-Id).
  app.post("/confirm", auth(), async (c) => {
    try {
      // Browser-only endpoint: a present Origin must be one the auth layer
      // trusts (the resolved set — app origin, loopback twins, operator
      // extras, split-host api origin). The old check compared against a
      // localhost-DEFAULTED constant, 403ing every LAN install whose operator
      // never set APP_URL. Absent Origin still passes (the CLI itself).
      const origin = c.req.header("origin");
      if (origin) {
        const allowed = trustedOrigins();
        const normalized = normalizeOrigin(origin);
        if (
          !allowed.includes("*") &&
          (!normalized || !allowed.includes(normalized))
        ) {
          return c.json({ error: "Forbidden" }, 403);
        }
      }

      const authCtx = c.get("auth");
      const workspaceId = requireWorkspaceId(authCtx);

      const body = (await c.req.json().catch(() => ({}))) as { code?: string };
      if (!body.code) {
        return c.json({ error: "Missing code" }, 400);
      }

      // The user's API key for the chosen workspace. resolveWorkspaceId already
      // verified the workspace belongs to the user, and this lookup is scoped to
      // their userId, so only their own key for their own workspace is shared.
      // `kind: "user"` so a platform-minted service key (e.g. a channel
      // presence's approvals key) sharing the same (user, workspace) can never
      // be handed to the CLI — that key is machine-only and gets revoked on
      // detach, which would silently break the CLI.
      const apiKey = await db.apiKey.findFirst({
        where: { userId: authCtx.userId, workspaceId, kind: "user" },
        select: { key: true },
      });

      if (!apiKey) {
        return c.json({ error: "No API key for this workspace" }, 404);
      }

      await confirmCliAuthSession(body.code, apiKey.key);

      // Authenticating a no-key install script counts as running it, so leave
      // onboarding mode now — matching the keyed install/migrate flows. Keyed by
      // the user we just authenticated (no extra lookup). Best-effort: it must
      // never block or fail the auth confirmation, hence the swallowed catch.
      await markOnboardingCompleteForUser(authCtx.userId).catch(() => {});

      return c.json({ status: "ok" });
    } catch (err) {
      if (err instanceof ServiceError) {
        const status =
          err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : 400;
        return c.json({ error: err.message }, status);
      }
      logger.error({ err }, "cli auth confirm failed");
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
};
