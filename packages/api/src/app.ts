import { Hono } from "hono";
import type { SessionProvider, OAuthOrgHandlers } from "./providers";
import type { CryptoService } from "./lib/crypto-types";
import type { AppDefinition } from "./apps/types";
import type { AppPermissionDefinition } from "./apps/app-permissions/types";
import type { ApiEnv } from "./types";
import {
  initSession,
  initCrypto,
  initCloudApps,
  initOAuthOrg,
  initSelfUrl,
} from "./providers";
import { registerAppPermission } from "./apps/app-permissions";
import { errorHandler } from "./middleware/error-handler";
import { healthRoutes } from "./routes/health";
import { agentRoutes } from "./routes/agents";
import { secretRoutes } from "./routes/secrets";
import { ruleRoutes } from "./routes/rules";
import { userRoutes } from "./routes/user";
import { appRoutes } from "./routes/apps";
import { gatewayUrlRoutes, gatewayCaRoutes } from "./routes/gateway";
import { containerConfigRoutes } from "./routes/container-config";
import { countsRoutes } from "./routes/counts";
import { skillRoutes } from "./routes/skill";
import { migrateRoutes } from "./routes/migrate";
import {
  authSessionRoutes,
  initSessionHooks,
  type SessionHooks,
} from "./routes/auth-session";

export interface CreateApiAppOptions {
  cloudRoutes?: (app: Hono<ApiEnv>) => void;
  crypto?: CryptoService;
  cloudApps?: AppDefinition[];
  cloudAppPermissions?: AppPermissionDefinition[];
  oauthOrg?: OAuthOrgHandlers;
  selfUrl?: string;
  sessionHooks?: Partial<SessionHooks>;
  version?: string;
}

export const createApiApp = (
  session: SessionProvider,
  options?: CreateApiAppOptions,
) => {
  initSession(session);
  if (options?.crypto) initCrypto(options.crypto);
  if (options?.cloudApps) initCloudApps(options.cloudApps);
  if (options?.cloudAppPermissions) {
    for (const perm of options.cloudAppPermissions) {
      registerAppPermission(perm);
    }
  }
  if (options?.oauthOrg) initOAuthOrg(options.oauthOrg);
  if (options?.selfUrl) initSelfUrl(options.selfUrl);
  if (options?.sessionHooks) initSessionHooks(options.sessionHooks);

  const app = new Hono<ApiEnv>().basePath("/v1");
  app.onError(errorHandler);

  app.route("/health", healthRoutes(options?.version));
  app.route("/auth/session", authSessionRoutes());
  app.route("/agents", agentRoutes());
  app.route("/secrets", secretRoutes());
  app.route("/rules", ruleRoutes());
  app.route("/user", userRoutes());
  app.route("/apps", appRoutes());
  app.route("/gateway-url", gatewayUrlRoutes());
  app.route("/gateway", gatewayCaRoutes());
  app.route("/container-config", containerConfigRoutes());
  app.route("/counts", countsRoutes());
  app.route("/skill", skillRoutes());
  app.route("/migrate", migrateRoutes());

  if (options?.cloudRoutes) {
    options.cloudRoutes(app);
  }

  return app;
};
