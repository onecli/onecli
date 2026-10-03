import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth, requireWorkspaceId, sessionAuth } from "../middleware/auth";
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
import {
  deleteAccount,
  planAccountDeletion,
} from "../services/account-deletion-service";
import { ServiceError } from "../services/errors";
import { updateProfileSchema } from "../validations/user";
import { createSshKeySchema } from "../validations/ssh-keys";

// Identity routes work without a workspace: an ORG key carries no workspace of
// its own, and `onecli auth login` verifies keys via GET /user — with the
// default requireWorkspace it read every org key as invalid. The api-key
// sub-routes stay workspace-scoped through their requireWorkspaceId calls
// (400 with the header hint, instead of the blanket 401). Per-handler rather
// than `use("*")` so the account-deletion pair below can run under the
// session-only `sessionAuth()` instead.
const identity = auth({ requireWorkspace: false });

// The account itself belongs to the PERSON, not to any tenant: these two
// must answer a user who belongs to no organization at all (an org-scoped
// auth could not even resolve their session), and an API key — which acts
// for a workspace or an org — may never delete the account that owns it.
const person = sessionAuth();

export const userRoutes = () => {
  const app = new Hono<ApiEnv>();

  // GET /user
  app.get("/", identity, async (c) => {
    const auth = c.get("auth");
    const user = await getUser(auth.userId);
    return c.json(user);
  });

  // PATCH /user
  app.patch("/", identity, async (c) => {
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

  // DELETE /user — the account, tearing down the user's organizations on the
  // way out (sole-member orgs deleted, shared orgs left). Refuses with 409
  // while the user owns an org that has other members. No audit row: every
  // row this user authored goes with the account.
  app.delete("/", person, async (c) => {
    await deleteAccount(c.get("sessionUser"));
    return c.body(null, 204);
  });

  // GET /user/deletion-impact — what DELETE /user would do to each of the
  // user's organizations, for the dialog to acknowledge one by one.
  app.get("/deletion-impact", person, async (c) => {
    const { userId } = c.get("sessionUser");
    return c.json({ organizations: await planAccountDeletion(userId) });
  });

  // GET /user/api-key
  app.get("/api-key", identity, async (c) => {
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
  app.post("/api-key/regenerate", identity, async (c) => {
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
  app.get("/ssh-keys", identity, async (c) => {
    const auth = c.get("auth");
    return c.json({ sshKeys: await listSshKeys(auth.userId) });
  });

  // POST /user/ssh-keys
  app.post("/ssh-keys", identity, async (c) => {
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
  app.delete("/ssh-keys/:keyId", identity, async (c) => {
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
