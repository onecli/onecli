// SERVER-ONLY barrel. The cloud implementations (KMS crypto, SSO
// enforcement, RBAC, org OAuth) are NOT imported here — they are injected at
// boot by `ensureEditionDefaults()` — but the barrel is still server-only:
// the local crypto default reaches node:crypto, and several onprem statics
// ride service graphs. Client code must NEVER import this index.
export {
  type OrgRole,
  ROLE_HIERARCHY,
  type AuthContext,
  type SessionUser,
  type SessionProvider,
  type RoleResolver,
  type WorkspaceAccessChecker,
  type WorkspaceRef,
  type SessionDenial,
  type SessionEnforcer,
  type SessionThrottle,
  type OAuthOrgHandlers,
  type OrgAppConfigProvider,
  type AppAvailabilityProvider,
  type CryptoService,
  type AppDefinition,
  type SshCaSigner,
} from "./types";

export { initSession, getSessionProvider } from "./session";
export { initCrypto, getCrypto } from "./crypto";
export { initSshCa, getSshCa } from "./ssh-ca";
export { type EventBus } from "../services/event-bus";
export { initEventBus, getEventBus } from "./event-bus";
export {
  type AttachmentBlobMeta,
  type AttachmentBlobRef,
  type AttachmentBlobStore,
  initAttachmentStore,
  getAttachmentStore,
} from "./attachment-store";
export { initOAuthOrg, getOAuthOrg } from "./oauth-org";
export { initOrgAppConfig, getOrgAppConfig } from "./org-app-config";
export { getAppAvailability } from "./app-availability";
export { initStrictApiKeyAuth, getStrictApiKeyAuth } from "./strict-api-keys";
export { initSelfUrl, getSelfUrl } from "./self-url";
export { initRoleResolver, getRoleResolver } from "./role-resolver";
export {
  initWorkspaceAccessChecker,
  getWorkspaceAccessChecker,
} from "./access-checker";
export { initSessionEnforcer, getSessionEnforcer } from "./session-enforcer";
export { initSessionThrottle, getSessionThrottle } from "./session-throttle";
export {
  type ResourceHooks,
  getResourceHooks,
  initResourceHooks,
  type ConnectionHooks,
  getConnectionHooks,
  initConnectionHooks,
  type PolicyValidator,
  initPolicyValidator,
  getPolicyValidator,
  type RuleActionGate,
  type RuleWriteScope,
  initRuleActionGate,
  getRuleActionGate,
  type NewOrgPolicySeeder,
  getNewOrgPolicySeeder,
} from "./hooks";
