import type { Hono } from "hono";
import type { ApiEnv } from "../types";
import { billingRoutes } from "./routes/billing";
import { ssoLookupRoutes } from "./routes/sso-lookup";
import { webhookRoutes } from "./routes/webhooks";
import { stripeWebhookRoutes } from "./routes/stripe-webhooks";
import { awsMarketplaceRoutes } from "./routes/aws-marketplace";
import { reviewerRoutes } from "./routes/reviewer";
import { workspaceAccessRoutes } from "./routes/workspace-access";
import { orgDomainRoutes } from "./routes/org-domains";
import { orgMemberRoutes } from "./routes/org-members";
import { orgSsoConnectionRoutes } from "./routes/org-sso-connections";
import { orgSsoEnforcementRoutes } from "./routes/org-sso-enforcement";
import { orgScimTokenRoutes } from "./routes/org-scim-tokens";
import { orgAppAvailabilityRoutes } from "./routes/org-app-availability";
import { orgGroupRoutes } from "./routes/org-groups";
import { orgRoleMappingRoutes } from "./routes/org-role-mappings";
import { teamRoutes } from "./routes/team";
import { provisionClaimRoutes } from "./routes/provision-claim";
import {
  removedOrgRuleRoutes,
  removedOrgSettingsRoutes,
} from "../routes/removed-routes";
import { dropboxFolderRoutes } from "./routes/dropbox-folders";

export const registerEeRoutes = (app: Hono<ApiEnv>) => {
  app.route("/auth/sso", ssoLookupRoutes());
  // Member provisioning (licensed): admin mint under /team (wire-compat with
  // the published SDK/docs), claim under its own prefix — teamRoutes' blanket
  // org-admin auth must never intercept an org-less claimer.
  app.route("/team", teamRoutes());
  app.route("/provisions", provisionClaimRoutes());
  app.route("/billing", billingRoutes());
  app.route("/webhooks", webhookRoutes());
  app.route("/webhooks/stripe", stripeWebhookRoutes());
  // AWS Marketplace license event intake (EventBridge → SNS → /events),
  // gated by SNS signature verification + topic allowlisting in the router.
  app.route("/billing/aws-marketplace", awsMarketplaceRoutes());
  app.route("/reviewer", reviewerRoutes());
  // Composed onto the shared `/workspaces` CRUD router mounted in app.ts.
  app.route("/workspaces", workspaceAccessRoutes());
  app.route("/org/domains", orgDomainRoutes());
  app.route("/org/sso/connections", orgSsoConnectionRoutes());
  app.route("/org/sso/enforcement", orgSsoEnforcementRoutes());
  app.route("/org/scim/tokens", orgScimTokenRoutes());
  app.route("/org/members", orgMemberRoutes());
  app.route("/org/app-availability", orgAppAvailabilityRoutes());
  // 410 Gone — the org-scope twins of the paths step 10 removed (see
  // routes/removed-routes.ts). Mounted after every live /org router.
  app.route("/org/rules", removedOrgRuleRoutes());
  app.route("/org/settings", removedOrgSettingsRoutes());
  app.route("/org/groups", orgGroupRoutes());
  app.route("/org/role-mappings", orgRoleMappingRoutes());
  app.route("/apps/dropbox", dropboxFolderRoutes());
};
