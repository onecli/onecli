import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { assertFeatureAllowed } from "../services/quota-service";
import {
  listScimTokens,
  createScimToken,
  revokeScimToken,
} from "../services/scim-token-service";
import { createScimTokenSchema } from "../validations/scim-token";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

const admin = auth({ requireWorkspace: false, role: "admin" });

/**
 * Bearer tokens for the org's SCIM endpoint. Creation is Enterprise-gated
 * ("sso" — provisioning is part of the SSO surface); the list stays readable
 * for the settings card, and REVOCATION is deliberately ungated — cutting
 * off an integration must never hide behind a plan check. The plaintext
 * token appears exactly once: in the 201 body.
 */
export const orgScimTokenRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("sso"));

  app.get("/", admin, async (c) => {
    const authCtx = c.get("auth");
    return c.json(await listScimTokens(authCtx.organizationId));
  });

  app.post("/", admin, async (c) => {
    const authCtx = c.get("auth");
    await assertFeatureAllowed(authCtx.organizationId, "sso");

    const body = await c.req.json().catch(() => null);
    const parsed = createScimTokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const created = await withAudit(
      () =>
        createScimToken(
          authCtx.organizationId,
          parsed.data.label,
          authCtx.userId,
        ),
      (token) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.SCIM_TOKEN,
        source: AUDIT_SOURCE.API,
        // Never the token or its hash — the id + label identify it.
        metadata: { tokenId: token.id, label: token.label },
      }),
    );
    return c.json(created, 201);
  });

  app.delete("/:tokenId", admin, async (c) => {
    const authCtx = c.get("auth");
    const tokenId = c.req.param("tokenId");

    await withAudit(
      () => revokeScimToken(authCtx.organizationId, tokenId),
      () => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.DELETE,
        service: AUDIT_SERVICES.SCIM_TOKEN,
        source: AUDIT_SOURCE.API,
        metadata: { tokenId },
      }),
    );
    return c.body(null, 204);
  });

  return app;
};
