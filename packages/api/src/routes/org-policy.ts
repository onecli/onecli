import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { registerPolicyRoutes } from "./policy";

// Org-scoped policy routes: /v1/org/policy/* — admin/owner only, mirroring
// org-rules. Writes still gate paid actions in the service (RuleActionGate).
export const orgPolicyRoutes = () => {
  const app = new Hono<ApiEnv>();
  const admin = auth({ requireWorkspace: false, role: "admin" });
  app.use("*", admin);
  registerPolicyRoutes(app, {
    resolveScope: (a) => ({ organizationId: a.organizationId }),
    auditScope: (a) => ({ organizationId: a.organizationId }),
  });
  return app;
};
