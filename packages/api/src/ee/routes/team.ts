import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import { z } from "zod";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { provisionUser } from "../services/user-provision-service";
import { appOrigin } from "../../lib/public-origins";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "../../services/audit-service";

// Deliberately non-strict with defaults: the published SDK sends `{}` when the
// caller passes no options, and pre-2.0 integrations must keep parsing.
const provisionUserSchema = z.object({
  role: z.enum(["admin", "member"]).default("member"),
  skipOnboarding: z.boolean().default(true),
});

export const teamRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("provisioning"));
  app.use("*", auth({ requireWorkspace: false, role: "admin" }));

  // POST /provisions
  app.post("/provisions", async (c) => {
    const authCtx = c.get("auth");

    const body = await c.req.json().catch(() => ({}));
    const parsed = provisionUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    const result = await withAudit(
      () =>
        provisionUser({
          organizationId: authCtx.organizationId,
          role: parsed.data.role,
          skipOnboarding: parsed.data.skipOnboarding,
          provisionedById: authCtx.userId,
          provisionedByEmail: authCtx.userEmail,
          appUrl: appOrigin(),
        }),
      (provision) => ({
        organizationId: authCtx.organizationId,
        userId: authCtx.userId,
        userEmail: authCtx.userEmail,
        action: AUDIT_ACTIONS.CREATE,
        service: AUDIT_SERVICES.PROVISION,
        source: AUDIT_SOURCE.API,
        // The token/claim URL is the credential — record what was minted for
        // whom, never the means of redeeming it (the API key stays out too).
        metadata: {
          provisionId: provision.id,
          userId: provision.userId,
          workspaceId: provision.workspaceId,
          role: parsed.data.role,
        },
      }),
    );

    // Wire compat: this response shape is a published contract (node-sdk
    // `provisionProject`, docs `guides/user-provisioning.mdx` + openapi.yaml)
    // that predates the project→workspace rename — the field stays
    // `projectId` on the wire while everything internal speaks workspace.
    return c.json(
      {
        id: result.id,
        userId: result.userId,
        projectId: result.workspaceId,
        apiKey: result.apiKey,
        claimUrl: result.claimUrl,
        expiresAt: result.expiresAt,
      },
      201,
    );
  });

  return app;
};
