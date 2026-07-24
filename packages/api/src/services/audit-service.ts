import { db, Prisma } from "@onecli/db";
import { logger } from "../lib/logger";
import {
  invalidateGatewayCacheForAccount,
  invalidateGatewayCacheForOrg,
} from "../lib/gateway-invalidate";

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUDIT_ACTIONS = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  REGENERATE: "regenerate",
  DISCONNECT: "disconnect",
  // Policy engine: snapshot the draft policy set into the published set.
  PUBLISH: "publish",
  // EE-only (partner layer): a user claims a partner-created org as its owner.
  CLAIM: "claim",
  // EE-only (identity): a claimed resource passed its ownership proof
  // (e.g. an org domain's DNS TXT check).
  VERIFY: "verify",
} as const;

export const AUDIT_SERVICES = {
  AGENT: "agent",
  SECRET: "secret",
  RULE: "rule",
  // Unified policy engine (policy_rules_v2): the priority-ordered rule model.
  POLICY: "policy",
  API_KEY: "api-key",
  APP_CONNECTION: "app-connection",
  APP_CONFIG: "app-config",
  // EE-only (policy-engine step 7): the org app-availability allowlist
  // (toggle + per-principal grants).
  APP_AVAILABILITY: "app-availability",
  PROJECT: "project",
  ORGANIZATION: "organization",
  // EE-only (partner layer)
  PARTNER: "partner",
  PARTNER_SECRET: "partner-secret",
  // EE-only (budget module): per-(secret, org) spend caps
  BUDGET: "budget",
  // EE-only (identity linking): auth-identity relink decisions
  AUTH: "auth",
  // EE-only (identity): org email domains (claim / verify / remove)
  DOMAIN: "domain",
  // EE-only (identity): org SSO/IdP connections
  SSO_CONNECTION: "sso-connection",
  // EE-only (identity): org membership rows (e.g. SSO JIT joins)
  MEMBER: "member",
  // EE-only (directory): human groups (manual + SCIM-provisioned)
  GROUP: "group",
  // EE-only (directory): OneCLI-native agent groups
  AGENT_GROUP: "agent-group",
  // EE-only (directory): group→org-role mappings (the mapping config itself;
  // the member role changes it drives are audited under MEMBER).
  ROLE_MAPPING: "role-mapping",
  // EE-only (directory): bearer tokens for the org's SCIM endpoint
  SCIM_TOKEN: "scim-token",
} as const;

export const AUDIT_STATUS = {
  SUCCESS: "success",
  FAILURE: "failure",
} as const;

export const AUDIT_SOURCE = {
  APP: "app",
  API: "api",
  // EE-only (partner layer): actions performed via the Partner API/portal.
  PARTNER: "partner",
  // EE-only (identity): state created by an SSO login itself (JIT joins,
  // connection activation) rather than by an interactive admin action.
  SSO_JIT: "sso-jit",
  // EE-only (identity): a group→role mapping re-applied at SSO login (step 15) —
  // distinct from SSO_JIT (a first-time join) since it re-resolves an existing
  // member's role.
  SSO_LOGIN: "sso-login",
  // EE-only (directory): writes pushed by the customer's IdP through the
  // SCIM endpoint (attributed to the org owner — SCIM has no acting user).
  SCIM: "scim",
} as const;

// ─── Types (derived from constants) ───────────────────────────────────────────

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
export type AuditService = (typeof AUDIT_SERVICES)[keyof typeof AUDIT_SERVICES];
export type AuditStatus = (typeof AUDIT_STATUS)[keyof typeof AUDIT_STATUS];
export type AuditSource = (typeof AUDIT_SOURCE)[keyof typeof AUDIT_SOURCE];

// ─── Service ──────────────────────────────────────────────────────────────────

export interface AuditEventParams {
  projectId?: string;
  organizationId?: string;
  userId: string;
  userEmail: string;
  action: AuditAction;
  service: AuditService;
  status: AuditStatus;
  source?: AuditSource;
  metadata?: Prisma.InputJsonValue;
}

const log = logger.child({ component: "audit" });

const logAuditEvent = async (params: AuditEventParams): Promise<void> => {
  const { source = AUDIT_SOURCE.APP, metadata, ...rest } = params;

  try {
    await db.auditLog.create({
      data: {
        ...rest,
        source,
        metadata: metadata ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    // Never fail the parent operation due to audit logging
    log.error({ err, ...params }, "failed to write audit log");
  }
};

// ─── HOF Wrapper ──────────────────────────────────────────────────────────────

export type AuditParams = Omit<AuditEventParams, "status"> & {
  status?: AuditStatus;
};

/**
 * Wraps a service call with audit logging.
 * Logs SUCCESS by default, but status can be overridden via getAuditParams.
 *
 * @param action - The service call to execute
 * @param getAuditParams - Function that returns audit params (receives action result)
 * @returns The result of the action
 *
 * @example
 * return withAudit(
 *   () => createSecretService(projectId, input),
 *   (secret) => ({
 *     projectId, userId,
 *     action: AUDIT_ACTIONS.CREATE,
 *     service: AUDIT_SERVICES.SECRET,
 *     metadata: { secretId: secret.id },
 *   })
 * );
 */
export const withAudit = async <T>(
  action: () => Promise<T>,
  getAuditParams: (result: T) => AuditParams,
): Promise<T> => {
  const result = await action();
  const params = getAuditParams(result);
  await logAuditEvent({
    status: AUDIT_STATUS.SUCCESS,
    ...params,
  });
  if (params.projectId) invalidateGatewayCacheForAccount(params.projectId);
  if (params.organizationId)
    invalidateGatewayCacheForOrg(params.organizationId);
  return result;
};

/**
 * Record a single audit event directly (status defaults to SUCCESS).
 *
 * Use when the audited state change is conditional or has already happened, so
 * the `withAudit` HOF — which always logs and flushes the gateway cache around a
 * wrapped call — doesn't fit. Example: auditing an API key only when it was
 * actually minted during a read (`ensureApiKey`). Like `logAuditEvent`, it never
 * throws — a failed audit write must not break the parent operation.
 */
export const recordAuditEvent = async (params: AuditParams): Promise<void> => {
  await logAuditEvent({
    ...params,
    status: params.status ?? AUDIT_STATUS.SUCCESS,
  });
};
