import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth, requireWorkspaceId } from "../middleware/auth";
import { getUser, updateProfile } from "../services/user-service";
import { ensureApiKey, regenerateApiKey } from "../services/api-key-service";
import {
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../services/audit-service";
import {
  createSshKey,
  deleteSshKey,
  listSshKeys,
} from "../services/ssh-key-service";
import { ServiceError } from "../services/errors";
import { updateProfileSchema } from "../validations/user";
import { createSshKeySchema } from "../validations/ssh-keys";

export const userRoutes = () => {
  const app = new Hono<ApiEnv>();
  // Identity routes work without a workspace: an ORG key carries no workspace of
  // its own, and `onecli auth login` verifies keys via GET /user — with the
  // default requireWorkspace it read every org key as invalid. The api-key
  // sub-routes stay workspace-scoped through their requireWorkspaceId calls
  // (400 with the header hint, instead of the blanket 401).
  app.use("*", auth({ requireWorkspace: false }));

  // GET /user
  app.get("/", async (c) => {
    const auth = c.get("auth");
    const user = await getUser(auth.userId);
    return c.json(user);
  });

  // PATCH /user
  app.patch("/", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const user = await updateProfile(auth.userId, parsed.data.name);
    return c.json(user);
  });

  // GET /user/api-key
  app.get("/api-key", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    const { apiKey, created } = await ensureApiKey(auth.userId, {
      workspaceId,
    });
    if (created) {
      await recordAuditEvent({
        workspaceId,
        userId: auth.userId,
        userEmail: auth.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.API_KEY,
        source: AUDIT_SOURCE.API,
        metadata: { scope: "workspace", autoProvisioned: true },
      });
    }
    return c.json({ apiKey });
  });

  // POST /user/api-key/regenerate
  app.post("/api-key/regenerate", async (c) => {
    const auth = c.get("auth");
    const result = await regenerateApiKey(auth.userId, {
      workspaceId: requireWorkspaceId(auth),
    });
    return c.json(result);
  });

  // The user's registered SSH public keys — account-level like GET / above
  // (a key authenticates the person to every agent they can reach, so no
  // workspace fence belongs here; authorization stays per-agent at mint).
  // New handlers use the ServiceError-throw style, not this file's legacy
  // bare-string 400s.

  // GET /user/ssh-keys
  app.get("/ssh-keys", async (c) => {
    const auth = c.get("auth");
    return c.json({ sshKeys: await listSshKeys(auth.userId) });
  });

  // POST /user/ssh-keys
  app.post("/ssh-keys", async (c) => {
    const auth = c.get("auth");
    const body = await c.req.json().catch(() => null);
    const parsed = createSshKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new ServiceError(
        "UNPROCESSABLE",
        parsed.error.issues[0]?.message ?? "Invalid request body",
      );
    }
    const sshKey = await createSshKey(
      {
        userId: auth.userId,
        userEmail: auth.userEmail,
        organizationId: auth.organizationId,
      },
      parsed.data,
    );
    return c.json({ sshKey }, 201);
  });

  // DELETE /user/ssh-keys/:keyId
  app.delete("/ssh-keys/:keyId", async (c) => {
    const auth = c.get("auth");
    await deleteSshKey(
      {
        userId: auth.userId,
        userEmail: auth.userEmail,
        organizationId: auth.organizationId,
      },
      c.req.param("keyId"),
    );
    return c.body(null, 204);
  });

  return app;
};
