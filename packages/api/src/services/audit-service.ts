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
  // Channels (step 6): a gateway approval decided from a provider surface —
  // the audit row that names the human clicker, since the gateway's own
  // `approved_by` can only carry the service key's owner.
  APPROVE: "approve",
  DENY: "deny",
  // Policy engine: snapshot the draft policy set into the published set.
  PUBLISH: "publish",
  // Memory (step 8): scrub one revision's snapshot in place — the one
  // deliberate history rewrite, first-class so compliance can grep for it.
  REDACT: "redact",
  // EE-only (identity): a claimed resource passed its ownership proof
  // (e.g. an org domain's DNS TXT check).
  VERIFY: "verify",
  // Team invitations (free on every edition): offering someone a place in the
  // organization, and their redeeming it. Distinct from CREATE/UPDATE because
  // an invitation is an offer — the membership it produces is audited too, and
  // reading "invite" then "accept" is how the join is reconstructed.
  INVITE: "invite",
  ACCEPT: "accept",
  // SSH front door (sandbox-platform step 5): a short-lived user certificate
  // signed for a (user, agent) pair — an access GRANT, so first-class rather
  // than CREATE. Metadata carries ids + the cert serial, never key material.
  MINT: "mint",
  // A live shell/scp/sftp session opening and closing. A human-driven shell
  // is new policy surface — these two rows are the entire session record
  // (content recording is deliberately out of scope, privacy posture).
  SESSION_OPEN: "session_open",
  SESSION_CLOSE: "session_close",
} as const;

export const AUDIT_SERVICES = {
  AGENT: "agent",
  SECRET: "secret",
  // Unified policy engine (policy_rules_v2): the priority-ordered rule model.
  // (The legacy `rule` service retired with the old model at step 10; historical
  // audit rows carrying it still render — the log table maps the raw string.)
  POLICY: "policy",
  // The attach-model grants surface (plans/project-attach-model.md, step 2):
  // agent⇄credential grants compiled into source:"grant" policy rules.
  GRANT: "grant",
  API_KEY: "api-key",
  APP_CONNECTION: "app-connection",
  APP_CONFIG: "app-config",
  // Channels (hosted-agents v2 step 6): org provider integrations and
  // per-agent presences (Slack first). Free — audited from the API routes.
  CHANNEL: "channel",
  // Scheduled tasks (hosted-agents v2 step 7): per-agent crons. Free —
  // audited from the API routes; agent-authored tool calls are not audited
  // here (the fired turns are their own record).
  CRON: "cron",
  // Agent memory (hosted-agents v2 step 8): per-agent durable memory with
  // revision history. Free — audited from the API routes; agent tool WRITES
  // are audited under the resolved creating user (viaAgent), reads never.
  MEMORY: "memory",
  // Skills (hosted-agents v2 step 9): user-authored capabilities materialized
  // into sandboxes. Free — audited from the API routes on both doors
  // (workspace and org); agent-authored skill_* tool writes are audited under
  // the resolved creating user (viaAgent), agent-tier rows only.
  SKILL: "skill",
  // EE-only (policy-engine step 7): the org app-availability allowlist
  // (toggle + per-principal grants).
  APP_AVAILABILITY: "app-availability",
  WORKSPACE: "workspace",
  ORGANIZATION: "organization",
  // EE-only (budget module, dormant): per-(secret, org) spend caps
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
  // EE-only (directory): group→org-role mappings (the mapping config itself;
  // the member role changes it drives are audited under MEMBER).
  ROLE_MAPPING: "role-mapping",
  // EE-only (directory): bearer tokens for the org's SCIM endpoint
  SCIM_TOKEN: "scim-token",
  // Team invitations. Free — collaboration is not an enterprise feature; the
  // membership rows an accepted invitation creates stay under MEMBER.
  INVITATION: "invitation",
  // EE-only (member provisioning): pre-minted placeholder accounts handed out
  // via claim links. CREATE = minted, ACCEPT = claimed.
  PROVISION: "provision",
  // SSH front door (sandbox-platform step 5): certificate mints (MINT) and
  // terminator-reported session open/close. Free shared code, dark without
  // an SSH CA configured; sourceIp in metadata is terminator-reported.
  SSH: "ssh",
} as const;

export const AUDIT_STATUS = {
  SUCCESS: "success",
  FAILURE: "failure",
} as const;

export const AUDIT_SOURCE = {
  APP: "app",
  API: "api",
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
  workspaceId?: string;
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
 *   () => createSecretService(workspaceId, input),
 *   (secret) => ({
 *     workspaceId, userId,
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
  if (params.workspaceId) invalidateGatewayCacheForAccount(params.workspaceId);
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
