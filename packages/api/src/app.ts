import { Hono } from "hono";
import type {
  SessionProvider,
  SessionEnforcer,
  OAuthOrgHandlers,
  OrgAppConfigProvider,
  AppAvailabilityProvider,
  ConnectionHooks,
  ResourceHooks,
  RoleResolver,
  PolicyValidator,
  RuleActionGate,
  NewOrgPolicySeeder,
} from "./providers";
import type { CryptoService } from "./lib/crypto-types";
import type { AppDefinition } from "./apps/types";
import type { AppPermissionDefinition } from "./apps/app-permissions/types";
import type { ApiEnv } from "./types";
import {
  initSession,
  initCrypto,
  initEeApps,
  initOAuthOrg,
  initOrgAppConfig,
  initAppAvailability,
  initConnectionHooks,
  initResourceHooks,
  initSelfUrl,
  initRoleResolver,
  initSessionEnforcer,
  initPolicyValidator,
  initRuleActionGate,
  initNewOrgPolicySeeder,
  initStrictApiKeyAuth,
} from "./providers";
import { registerAppPermission } from "./apps/app-permissions";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { agentRoutes } from "./routes/agents";
import { secretRoutes } from "./routes/secrets";
import { policyRoutes } from "./routes/policy";
import {
  policyReflectRoutes,
  agentReflectRoutes,
  connectionReflectRoutes,
} from "./routes/policy-reflect";
import {
  removedAgentEquipmentRoutes,
  removedConnectionAgentRoutes,
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
import { migrateRoutes } from "./routes/migrate";
import { internalRoutes } from "./routes/internal";
import {
  authSessionRoutes,
  initSessionHooks,
  type SessionHooks,
} from "./routes/auth-session";

export interface CreateApiAppOptions {
  eeRoutes?: (app: Hono<ApiEnv>) => void;
  crypto?: CryptoService;
  eeApps?: AppDefinition[];
  eeAppPermissions?: AppPermissionDefinition[];
  oauthOrg?: OAuthOrgHandlers;
  orgAppConfig?: OrgAppConfigProvider;
  appAvailability?: AppAvailabilityProvider;
  connectionHooks?: ConnectionHooks;
  resourceHooks?: ResourceHooks;
  selfUrl?: string;
  roleResolver?: RoleResolver;
  /**
   * Edition policy over authenticated sessions (e.g. enterprise "require
   * SSO"): consulted at session resolution; a denial rejects with 401 + the
   * denial body. OSS never sets it — sessions are always allowed.
   */
  sessionEnforcer?: SessionEnforcer;
  policyValidator?: PolicyValidator;
  ruleActionGate?: RuleActionGate;
  /**
   * Seeds a new org's initial published policy on bootstrap (cloud: a
   * secure-by-default org Default Rule). OSS never sets it — new orgs stay on
   * the old model until step 9.
   */
  newOrgPolicySeeder?: NewOrgPolicySeeder;
  sessionHooks?: Partial<SessionHooks>;
  /**
   * Commit `oc_` bearers to API-key auth: when set, a failed API-key
   * authentication returns 401 instead of falling through to session auth.
   * EE editions enable it; the OSS default keeps today's fallthrough.
   */
  strictApiKeyAuth?: boolean;
  version?: string;
}

export const createApiApp = (
  session: SessionProvider,
  options?: CreateApiAppOptions,
) => {
  initSession(session);
  if (options?.crypto) initCrypto(options.crypto);
  if (options?.eeApps) initEeApps(options.eeApps);
  if (options?.eeAppPermissions) {
    for (const perm of options.eeAppPermissions) {
      registerAppPermission(perm);
    }
  }
  if (options?.oauthOrg) initOAuthOrg(options.oauthOrg);
  if (options?.orgAppConfig) initOrgAppConfig(options.orgAppConfig);
  if (options?.appAvailability) initAppAvailability(options.appAvailability);
  if (options?.connectionHooks) initConnectionHooks(options.connectionHooks);
  if (options?.resourceHooks) initResourceHooks(options.resourceHooks);
  if (options?.selfUrl) initSelfUrl(options.selfUrl);
  if (options?.roleResolver) initRoleResolver(options.roleResolver);
  if (options?.sessionEnforcer) initSessionEnforcer(options.sessionEnforcer);
  if (options?.policyValidator) initPolicyValidator(options.policyValidator);
  if (options?.ruleActionGate) initRuleActionGate(options.ruleActionGate);
  if (options?.newOrgPolicySeeder)
    initNewOrgPolicySeeder(options.newOrgPolicySeeder);
  if (options?.sessionHooks) initSessionHooks(options.sessionHooks);
  if (options?.strictApiKeyAuth) initStrictApiKeyAuth(options.strictApiKeyAuth);

  const app = new Hono<ApiEnv>().basePath("/v1");
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/health", healthRoutes(options?.version));
  app.route("/auth/session", authSessionRoutes());
  app.route("/agents", agentRoutes());
  app.route("/secrets", secretRoutes());
  app.route("/policy", policyRoutes());
  app.route("/user", userRoutes());
  app.route("/apps", appRoutes());
  app.route("/connections", connectionRoutes());
  // Read-only policy reflections (step 9.7b) compose onto the same base paths.
  // Since step 10 they are SHARED — OSS shows the credential-access dialog too —
  // and each route redacts org-rule details via the roleResolver provider (null
  // in OSS → fail-safe non-admin).
  app.route("/policy", policyReflectRoutes());
  app.route("/agents", agentReflectRoutes());
  app.route("/connections", connectionReflectRoutes());
  app.route("/vaults", vaultRoutes());
  app.route("/gateway-url", gatewayUrlRoutes());
  app.route("/gateway", gatewayCaRoutes());
  app.route("/container-config", containerConfigRoutes());
  app.route("/counts", countsRoutes());
  app.route("/skill", skillRoutes());
  app.route("/credential-stubs", credentialStubRoutes());
  app.route("/migrate", migrateRoutes());
  app.route("/internal", internalRoutes());
  // 410 Gone for the old-model paths step 10 removed. LAST, so every live route
  // above wins the first-match — these only catch what no longer exists.
  app.route("/rules", removedRuleRoutes());
  app.route("/agents", removedAgentEquipmentRoutes());
  app.route("/connections", removedConnectionAgentRoutes());

  if (options?.eeRoutes) {
    options.eeRoutes(app);
  }

  return app;
};
