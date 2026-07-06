import { Hono } from "hono";
import type {
  SessionProvider,
  OAuthOrgHandlers,
  ConnectionHooks,
  ResourceHooks,
  RoleResolver,
  PolicyValidator,
  RuleActionGate,
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
  initConnectionHooks,
  initResourceHooks,
  initSelfUrl,
  initRoleResolver,
  initPolicyValidator,
  initRuleActionGate,
} from "./providers";
import { registerAppPermission } from "./apps/app-permissions";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { agentRoutes } from "./routes/agents";
import { secretRoutes } from "./routes/secrets";
import { ruleRoutes } from "./routes/rules";
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
  connectionHooks?: ConnectionHooks;
  resourceHooks?: ResourceHooks;
  selfUrl?: string;
  roleResolver?: RoleResolver;
  policyValidator?: PolicyValidator;
  ruleActionGate?: RuleActionGate;
  sessionHooks?: Partial<SessionHooks>;
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
  if (options?.connectionHooks) initConnectionHooks(options.connectionHooks);
  if (options?.resourceHooks) initResourceHooks(options.resourceHooks);
  if (options?.selfUrl) initSelfUrl(options.selfUrl);
  if (options?.roleResolver) initRoleResolver(options.roleResolver);
  if (options?.policyValidator) initPolicyValidator(options.policyValidator);
  if (options?.ruleActionGate) initRuleActionGate(options.ruleActionGate);
  if (options?.sessionHooks) initSessionHooks(options.sessionHooks);

  const app = new Hono<ApiEnv>().basePath("/v1");
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/health", healthRoutes(options?.version));
  app.route("/auth/session", authSessionRoutes());
  app.route("/agents", agentRoutes());
  app.route("/secrets", secretRoutes());
  app.route("/rules", ruleRoutes());
  app.route("/user", userRoutes());
  app.route("/apps", appRoutes());
  app.route("/connections", connectionRoutes());
  app.route("/vaults", vaultRoutes());
  app.route("/gateway-url", gatewayUrlRoutes());
  app.route("/gateway", gatewayCaRoutes());
  app.route("/container-config", containerConfigRoutes());
  app.route("/counts", countsRoutes());
  app.route("/skill", skillRoutes());
  app.route("/credential-stubs", credentialStubRoutes());
  app.route("/migrate", migrateRoutes());
  app.route("/internal", internalRoutes());

  if (options?.eeRoutes) {
    options.eeRoutes(app);
  }

  return app;
};
