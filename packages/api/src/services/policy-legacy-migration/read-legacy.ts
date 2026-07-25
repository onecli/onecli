/**
 * Reading the frozen old model — see ./README.md. Two halves:
 *
 *  - `OSS_OLD_RULE_SELECT` + `reconstructOssRule`: the legacy `policy_rules`
 *    columns the translation reads, and the inverse map (a stored v2 row back
 *    to its `BackfillRuleInput` shape) that lets the migration verify what it
 *    just wrote.
 *  - `readOssEquipment`: a project's selective agents' per-agent credential
 *    grants (`agent_secrets` / `agent_app_connections`), which become
 *    `source="equipment"` rules.
 *
 * These are the ONLY reads of the deprecated tables outside the boot guard and
 * the FK cleanup on delete; they go when the tables do.
 */
import { type Prisma } from "@onecli/db";
import type { BackfillRuleInput, BackfillTargetInput } from "../policy-service";
import type { OssAgentEquipment } from "./translate";
import type { PolicyIdentityInput } from "../../validations/policy";

/** The legacy-row columns the OSS translation reads. */
export const OSS_OLD_RULE_SELECT = {
  id: true,
  name: true,
  agentId: true,
  hostPattern: true,
  pathPattern: true,
  method: true,
  action: true,
  enabled: true,
  rateLimit: true,
  rateLimitWindow: true,
  metadata: true,
  conditions: true,
} as const;

type StoredRuleRow = {
  id: string;
  priority: number;
  isDefault: boolean;
  source: string;
  name: string;
  description: string | null;
  action: string;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  requireApproval: boolean;
  enabled: boolean;
  conditions: unknown;
  identities: {
    agentId: string | null;
    agentGroupId: string | null;
    userId: string | null;
    groupId: string | null;
  }[];
  targets: {
    kind: string;
    appProvider: string | null;
    appTools: string[];
    appConnectionScope: string | null;
    appConnectionId: string | null;
    secretId: string | null;
    secretScope: string | null;
    hostPattern: string | null;
    pathPattern: string | null;
    method: string | null;
  }[];
};

const reconstructIdentity = (
  i: StoredRuleRow["identities"][number],
): PolicyIdentityInput => {
  if (i.agentId) return { type: "agent", id: i.agentId };
  if (i.agentGroupId) return { type: "agentGroup", id: i.agentGroupId };
  if (i.userId) return { type: "user", id: i.userId };
  return { type: "group", id: i.groupId ?? "" };
};

const reconstructTarget = (
  t: StoredRuleRow["targets"][number],
): BackfillTargetInput => {
  switch (t.kind) {
    case "app":
      return {
        kind: "app",
        provider: t.appProvider ?? "",
        tools: t.appTools,
        connectionScope:
          t.appConnectionScope === "organization" ||
          t.appConnectionScope === "project"
            ? t.appConnectionScope
            : null,
      };
    case "connection":
      return {
        kind: "connection",
        connectionId: t.appConnectionId ?? "",
        tools: t.appTools,
      };
    case "secret":
      return { kind: "secret", secretId: t.secretId ?? "" };
    default:
      return {
        kind: "network",
        hostPattern: t.hostPattern ?? "",
        pathPattern: t.pathPattern,
        method: t.method,
      };
  }
};

/**
 * A stored v2 row back to the `BackfillRuleInput` shape — the ordering view
 * the pinned merge compares (identities count + action/modifiers) and the
 * verify canon. Faithful for every shape the OSS translation emits; a
 * user-authored scope-form secret target degrades to its id form (targets
 * never influence ordering, and the boot verify only ever sees the
 * translation's own output).
 */
export const reconstructOssRule = (row: StoredRuleRow): BackfillRuleInput => ({
  priority: row.priority,
  isDefault: row.isDefault,
  source: row.source as BackfillRuleInput["source"],
  name: row.name,
  description: row.description,
  action: row.action === "block" ? "block" : "allow",
  rateLimit: row.rateLimit,
  rateLimitWindow:
    row.rateLimitWindow === "minute" ||
    row.rateLimitWindow === "hour" ||
    row.rateLimitWindow === "day"
      ? row.rateLimitWindow
      : null,
  requireApproval: row.requireApproval,
  conditions: row.conditions ?? null,
  identities: row.identities.map(reconstructIdentity),
  targets: row.targets.map(reconstructTarget),
  enabled: row.enabled,
});

/** Equipment can reference project- OR org-scoped resources in OSS (the
 * implicit org): the legacy gateway join injects both scope-blind, and OSS has
 * no org rules to carry the org-scoped ones — the project equipment rule is
 * their ONLY vehicle. This deliberately DIVERGES from the EE derivation's
 * project-only fence (cloud's org resources travel via org rules); the
 * gateway's fenced two-arm loaders resolve org-scoped ids fine. Partner scope
 * stays excluded (cloud-only). */
const OSS_EQUIPMENT_SCOPES = new Set(["project", "organization"]);

/**
 * Read a project's selective agents' equipment — project- and org-scoped
 * resources alike (see `OSS_EQUIPMENT_SCOPES`), so no legacy-injected
 * credential is silently dropped at the cutover.
 */
export const readOssEquipment = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<OssAgentEquipment[]> => {
  const agents = await tx.agent.findMany({
    where: { projectId },
    select: {
      id: true,
      secretMode: true,
      agentSecrets: {
        select: { secretId: true, secret: { select: { scope: true } } },
      },
      agentAppConnections: {
        select: {
          appConnectionId: true,
          sessionPolicy: true,
          appConnection: { select: { scope: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return agents.map((a) => ({
    agentId: a.id,
    secretMode: a.secretMode,
    secretIds: a.agentSecrets
      .filter((s) => OSS_EQUIPMENT_SCOPES.has(s.secret.scope))
      .map((s) => s.secretId),
    connections: a.agentAppConnections
      .filter((c) => OSS_EQUIPMENT_SCOPES.has(c.appConnection.scope))
      .map((c) => ({
        appConnectionId: c.appConnectionId,
        sessionPolicy: c.sessionPolicy,
      })),
  }));
};
