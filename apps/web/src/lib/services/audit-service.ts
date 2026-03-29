import { db, Prisma } from "@onecli/db";
import { logger } from "@/lib/logger";

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUDIT_ACTIONS = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  REGENERATE: "regenerate",
  CONNECT: "connect",
  DISCONNECT: "disconnect",
} as const;

export const AUDIT_SERVICES = {
  AGENT: "agent",
  SECRET: "secret",
  RULE: "rule",
  API_KEY: "api-key",
  APP_CONNECTION: "app-connection",
  APP_CONFIG: "app-config",
} as const;

export const AUDIT_STATUS = {
  SUCCESS: "success",
  FAILURE: "failure",
} as const;

export const AUDIT_SOURCE = {
  APP: "app",
  API: "api",
} as const;

// ─── Types (derived from constants) ───────────────────────────────────────────

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
export type AuditService = (typeof AUDIT_SERVICES)[keyof typeof AUDIT_SERVICES];
export type AuditStatus = (typeof AUDIT_STATUS)[keyof typeof AUDIT_STATUS];
export type AuditSource = (typeof AUDIT_SOURCE)[keyof typeof AUDIT_SOURCE];

// ─── Service ──────────────────────────────────────────────────────────────────

export interface AuditEventParams {
  accountId: string;
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
 *   () => createSecretService(accountId, input),
 *   (secret) => ({
 *     accountId, userId,
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
  await logAuditEvent({
    status: AUDIT_STATUS.SUCCESS,
    ...getAuditParams(result),
  });
  return result;
};
