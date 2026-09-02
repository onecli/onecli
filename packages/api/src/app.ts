import { Hono } from "hono";
import type {
  SessionProvider,
  OrgAppConfigProvider,
  RoleResolver,
  PolicyValidator,
  RuleActionGate,
} from "./providers";
import type { ApiEnv } from "./types";
import {
  initSession,
  initOrgAppConfig,
  initSelfUrl,
  initRoleResolver,
  initPolicyValidator,
  initRuleActionGate,
} from "./providers";
import { ensureEditionDefaults } from "./edition-defaults";
import { registerEeRoutes } from "./ee";
import { installLegacyProjectCompat } from "./lib/legacy-project-compat";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instance";
import { agentRoutes } from "./routes/agents";
import { agentImageRoutes } from "./routes/agent-images";
import { secretRoutes } from "./routes/secrets";
import {
  policyReflectRoutes,
  agentReflectRoutes,
  connectionReflectRoutes,
  orgPolicyReflectRoutes,
} from "./routes/policy-reflect";
import { unsubscribeRoutes } from "./routes/unsubscribe";
import { agentGrantsRoutes, connectionGrantsRoutes } from "./routes/grants";
import {
  removedAgentEquipmentRoutes,
  removedAgentGroupsLookupRoutes,
  removedConnectionAgentRoutes,
  removedOrgAgentGroupRoutes,
  removedOrgAgentRoutes,
  removedWorkspacePolicyRoutes,
  removedRuleRoutes,
} from "./routes/removed-routes";
import { userRoutes } from "./routes/user";
import { appRoutes } from "./routes/apps";
import { connectionRoutes } from "./routes/connections";
import { vaultRoutes } from "./routes/vaults";
import { gatewayUrlRoutes, gatewayCaRoutes } from "./routes/gateway";
import { containerConfigRoutes } from "./routes/container-config";
import { countsRoutes } from "./routes/counts";
import { skillRoutes } from "./routes/skill";
import { credentialStubRoutes } from "./routes/credential-stubs";
import { migrateNanoclawRoutes } from "./routes/migrate-nanoclaw";
import { orgRoutes } from "./routes/org";
import { internalRoutes } from "./routes/internal";
import { runnerRoutes } from "./routes/runner";
import { conversationRoutes, turnRoutes } from "./routes/conversations";
import { orgChannelRoutes } from "./routes/org-channels";
import { agentChannelRoutes } from "./routes/agent-channels";
import { agentCronRoutes } from "./routes/agent-crons";
import { agentMemoryRoutes } from "./routes/agent-memories";
import { userSkillRoutes } from "./routes/skills";
import { orgSkillRoutes } from "./routes/org-skills";
import { channelAdapterRoutes } from "./routes/channel-adapter";
import { sshTerminatorRoutes } from "./routes/ssh-terminator";
import { channelInboundRoutes } from "./routes/channel-inbound";
import { runnersRoutes } from "./routes/runners";
import {
  authSessionRoutes,
  initSessionHooks,
  type SessionHooks,
} from "./routes/auth-session";
import {
  orgInvitationRoutes,
  invitationAcceptRoutes,
} from "./routes/invitations";
import { cliAuthRoutes } from "./routes/cli-auth";
import { installRoutes } from "./routes/install";
import { onboardingRoutes } from "./routes/onboarding";
import { faviconRoutes } from "./routes/favicon";
import { workspaceRoutes } from "./routes/workspaces";
import { orgPolicyRoutes } from "./routes/org-policy";
import { orgSecretRoutes } from "./routes/org-secrets";
import { orgConnectionRoutes } from "./routes/org-connections";
import { orgAppRoutes, orgAppRoutesLegacy } from "./routes/org-apps";

/**
 * Host-level overrides of the edition defaults. Every provider seam resolves
 * its own implementation from the runtime edition (`IS_CLOUD`) — these options
 * exist only where a host genuinely varies (selfUrl, sessionHooks, version) or
 * where tests need an injection point (the rest).
 */
export interface CreateApiAppOptions {
  /**
   * Extra route registration, mounted after the shared routes. Default when
   * absent: BOTH editions mount the full EE surface (`registerEeRoutes`) —
   * onprem serves the same org-scoped web surface (/v1/workspaces, /v1/org/*),
   * and behavior inside degrades per-edition via the providers (roles no-op,
   * quotas unlimited, SSO absent). An explicit value always wins — tests use
   * it to mount a single router under test.
   */
  eeRoutes?: (app: Hono<ApiEnv>) => void;
  /** Override of the edition default (cloud: org-level app-config reads). */
  orgAppConfig?: OrgAppConfigProvider;
  /**
   * This host's own public URL (OAuth callbacks, redirects). Defaults to
   * APP_URL — the api-server passes its API origin instead.
   */
  selfUrl?: string;
  /** Override of the edition default (cloud: membership-table RBAC). */
  roleResolver?: RoleResolver;
  /** Override of the edition default (cloud: plan-gated granular access;
   * onprem: the granular-scoping lock). */
  policyValidator?: PolicyValidator;
  /** Override of the edition default (cloud: plan-gated rule actions;
   * onprem: allow-all). */
  ruleActionGate?: RuleActionGate;
  sessionHooks?: Partial<SessionHooks>;
  version?: string;
}

export const createApiApp = (
  session: SessionProvider,
  options?: CreateApiAppOptions,
) => {
  ensureEditionDefaults();
  initSession(session);
  if (options?.orgAppConfig) initOrgAppConfig(options.orgAppConfig);
  if (options?.selfUrl) initSelfUrl(options.selfUrl);
  if (options?.roleResolver) initRoleResolver(options.roleResolver);
  if (options?.policyValidator) initPolicyValidator(options.policyValidator);
  if (options?.ruleActionGate) initRuleActionGate(options.ruleActionGate);
  if (options?.sessionHooks) initSessionHooks(options.sessionHooks);

  const app = new Hono<ApiEnv>().basePath("/v1");
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  // Rename compat (TEMPORARY, see the file's deletion recipe): bridges the
  // legacy X-Project-Id/?_project scope inputs and aliases /v1/projects*.
  // Before every route mount, so the middleware precedes all handlers.
  installLegacyProjectCompat(app);

  app.route("/health", healthRoutes(options?.version));
  app.route("/instance", instanceRoutes(options?.version));
  app.route("/auth/session", authSessionRoutes());
  app.route("/auth/cli", cliAuthRoutes());
  // Invitations are free on every edition — mounted from the shared app, not
  // from registerEeRoutes.
  app.route("/org/invitations", orgInvitationRoutes());
  app.route("/invitations", invitationAcceptRoutes());
  app.route("/agents", agentRoutes());
  // The PUBLIC avatar read — sessionless on purpose (Slack fetches icon_url
  // with no credentials); the fence is the unguessable imageKey in the path.
  app.route("/agent-images", agentImageRoutes());
  app.route("/secrets", secretRoutes());
  app.route("/user", userRoutes());
  app.route("/apps", appRoutes());
  app.route("/connections", connectionRoutes());
  // Read-only policy reflections (step 9.7b) compose onto the same base paths.
  // Since step 10 they are SHARED — onprem shows the credential-access dialog
  // too — and each route redacts org-rule details via the roleResolver provider
  // (null in onprem → fail-safe non-admin).
  app.route("/policy", policyReflectRoutes());
  app.route("/agents", agentReflectRoutes());
  app.route("/connections", connectionReflectRoutes());
  // The org-scoped reflection is FREE like the rest (decided 2026-08-17):
  // org-scope rules bind free deployments (only their group arms are
  // licensed), so the admins they bind can see them. Admin-only via auth.
  app.route("/org/policy", orgPolicyReflectRoutes());
  // One-click unsubscribe (RFC 8058) — free shared behavior: any deployment
  // that sends email links here. Token-only; sessionless by nature.
  app.route("/webhooks/unsubscribe", unsubscribeRoutes());
  // The attach-model grants surface (step 2): agent⇄credential grants compiled
  // into source:"grant" policy rules, composed onto the same base paths.
  app.route("/agents", agentGrantsRoutes());
  app.route("/connections", connectionGrantsRoutes());
  app.route("/vaults", vaultRoutes());
  app.route("/gateway-url", gatewayUrlRoutes());
  app.route("/gateway", gatewayCaRoutes());
  app.route("/container-config", containerConfigRoutes());
  app.route("/counts", countsRoutes());
  app.route("/skill", skillRoutes());
  app.route("/credential-stubs", credentialStubRoutes());
  // User-authored skills (step 9) — /skills, distinct from the gateway
  // skill's untouched /skill mount above.
  app.route("/skills", userSkillRoutes());
  app.route("/migrate", migrateNanoclawRoutes());
  app.route("/install", installRoutes());
  app.route("/onboarding", onboardingRoutes());
  app.route("/favicon", faviconRoutes());
  // Workspace CRUD; the org-scoped access surface (`workspaceAccessRoutes`)
  // composes onto this same base path from the EE block below.
  app.route("/workspaces", workspaceRoutes());
  // The current-org read (bare /v1/org). Its middleware is per-handler, never
  // `use("*")`, so it cannot shadow the /org/<segment> routers around it.
  app.route("/org", orgRoutes());
  // Org policy CRUD. Shares the base path with `orgPolicyReflectRoutes`
  // (mounted with the other reflections above) — the two define disjoint
  // sub-paths, and both apply the same org-admin auth.
  app.route("/org/policy", orgPolicyRoutes());
  // Channels (step 6, FREE — §3.16): org integrations beside org-policy in
  // the free block, ahead of the EE /org/* routers.
  app.route("/org/channels", orgChannelRoutes());
  // Org-tier skills (step 9) — free like channels, admin-gated writes.
  app.route("/org/skills", orgSkillRoutes());
  // Org credentials (secrets, connections, apps): free on every edition —
  // one org-level connection/secret serves every workspace. Admin-gated
  // writes like the other free /org routers.
  app.route("/org/secrets", orgSecretRoutes());
  app.route("/org/connections", orgConnectionRoutes());
  app.route("/org/apps", orgAppRoutes());
  // Wire-compat forwards for deployed CLIs (/org/app-config/* → /org/apps/*).
  orgAppRoutesLegacy(app);
  // The channel providers' inbound HTTP arms: signature-trusted webhooks +
  // OAuth install callbacks, mounted per provider id from the inbound-route
  // registry. No session auth by design — see each file's trust model.
  app.route("/channels", channelInboundRoutes());
  app.route("/internal", internalRoutes());
  // The compute plane (hosted agents, §3.3): `/runner` is the daemon's own
  // outbound surface, authenticated by the `rnr_` family alone; `/runners` is
  // the read-only human view, on the normal user auth.
  // The conversation plane (step 4): conversations own their turns and
  // transcript; `/turns` exists only for the abort verb, kept shallow.
  app.route("/conversations", conversationRoutes());
  app.route("/turns", turnRoutes());
  app.route("/runner", runnerRoutes());
  app.route("/runners", runnersRoutes());
  // The channel adapter's own surface (step 6): `cha_` family only, the
  // runner-daemon pattern.
  app.route("/channel-adapter", channelAdapterRoutes());
  // The SSH terminator's own surface (sandbox-platform step 5): static
  // terminator secret only — the narrow terminator↔control-plane channel.
  // Dark (blanket 401) until SSH_TERMINATOR_SECRET is configured.
  app.route("/ssh-terminator", sshTerminatorRoutes());
  // The agent's channel presences, composed onto /agents ahead of the 410
  // shims (every path here is 2+ segments, so the agents router's
  // single-segment `/:agentId` routes never shadow it).
  app.route("/agents", agentChannelRoutes());
  // The agent's schedules (step 7) — same composition rule as channels.
  app.route("/agents", agentCronRoutes());
  // The agent's memory (step 8) — same composition rule as channels.
  app.route("/agents", agentMemoryRoutes());
  // 410 Gone for the old-model paths step 10 removed. LAST, so every live route
  // above wins the first-match — these only catch what no longer exists.
  app.route("/rules", removedRuleRoutes());
  app.route("/agents", removedAgentEquipmentRoutes());
  app.route("/connections", removedConnectionAgentRoutes());
  // Workspace-scope policy CRUD retired in attach-model step 6. Mounted on the
  // same base path as `policyReflectRoutes` above, which is why the shim
  // enumerates exact sub-paths instead of a wildcard: the reflections
  // (`/v1/policy/effective-app-permissions`) must keep answering.
  app.route("/policy", removedWorkspacePolicyRoutes());
  // 410 Gone — the agent-groups directory surface (feature removed 2026-07).
  // The `/agents` lookup shim mounts after every live `/agents` router above.
  app.route("/org/agent-groups", removedOrgAgentGroupRoutes());
  app.route("/org/agents", removedOrgAgentRoutes());
  app.route("/agents", removedAgentGroupsLookupRoutes());

  if (options?.eeRoutes) {
    options.eeRoutes(app);
  } else {
    registerEeRoutes(app);
  }

  return app;
};
