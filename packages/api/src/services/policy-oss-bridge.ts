/**
 * The OSS coherence bridge (step 9.5): keep the v2 generation current while
 * the legacy blocklist + equipment editors stay live until step 10.
 *
 * OSS's blocklist writes (panel routes, connect-time seeding, connection
 * deletion) and equipment writes (secretMode / AgentSecret /
 * AgentAppConnection) still land in the old model; the gateway reads v2. This
 * re-derives the bridge-owned rows (`bridgeDerivedSources()` — blocklist +
 * equipment at editing-on) from the current old model whenever those editors
 * write, mirroring the EE bridge's project arm: kept custom rules NEVER
 * permute (the pinned merge), persistence goes through the shared
 * `applyRematerialization` (signature no-op skip, generation retention).
 *
 * Wired as the `policyCoherenceBridge` DI for the OSS edition only
 * (`apps/web/src/lib/init/api.ts` — a file every EE edition aliases away).
 */
import { db, type Prisma } from "@onecli/db";
import { bridgeDerivedSources } from "../lib/policy-flags";
import type { PolicyCoherenceBridge } from "../providers";
import {
  applyRematerialization,
  lockScope,
  policyScope,
  readCurrentPublishedGeneration,
  type BackfillRuleInput,
  type BackfillTargetInput,
} from "./policy-service";
import {
  ossRuleOrderComparator,
  translateOssBlocklistRows,
  translateOssEquipment,
  type OssAgentEquipment,
  type OssOldRule,
} from "./policy-oss-translate";
import type { PolicyIdentityInput } from "../validations/policy";

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

type KeptRule = { id: string; rule: BackfillRuleInput };

export interface OssInterleaveResult {
  customPriorities: { id: string; priority: number }[];
  /** Aligned with the input `derived` order. */
  derivedPriorities: number[];
}

/**
 * The pinned merge, project arm (mirror of the EE `interleaveDerived`): kept
 * customs keep their manual relative order — never permuted; derived rules
 * sort among themselves by the ordering law (stable → translator input order
 * ties) and each slots before the FIRST kept custom that orders strictly
 * looser, else after all customs. Ties go to the custom.
 */
export const interleaveOssDerived = (
  kept: KeptRule[],
  derived: BackfillRuleInput[],
): OssInterleaveResult => {
  const sortedDerived = derived
    .map((rule, idx) => ({ idx, rule }))
    .sort((a, b) => ossRuleOrderComparator(a.rule, b.rule));
  const slots = sortedDerived.map((d) => {
    const before = kept.findIndex(
      (k) => ossRuleOrderComparator(d.rule, k.rule) < 0,
    );
    return { idx: d.idx, slot: before === -1 ? kept.length : before };
  });

  const customPriorities: { id: string; priority: number }[] = [];
  const derivedPriorities: number[] = new Array<number>(derived.length);
  let priority = 0;
  kept.forEach((k, slot) => {
    for (const s of slots) {
      if (s.slot === slot) derivedPriorities[s.idx] = priority++;
    }
    customPriorities.push({ id: k.id, priority: priority++ });
  });
  for (const s of slots) {
    if (s.slot === kept.length) derivedPriorities[s.idx] = priority++;
  }
  return { customPriorities, derivedPriorities };
};

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

/**
 * Re-derive one project's bridge-owned rules from the current old model.
 * Gated on the project's own published generation — the OSS cutover marker
 * (every cut project holds at least its Default Rule); an uncut project is
 * left alone (a partial materialization would be permanent, and the gateway
 * is still on legacy for it anyway).
 */
export const rematerializeOssScope = async (scope: {
  projectId?: string;
  organizationId?: string;
}): Promise<void> => {
  // OSS has no org scope; org-scope notifications (unreachable in OSS route
  // registrations, but the DI is shared) are a no-op.
  if (!scope.projectId) return;
  const base = policyScope({ projectId: scope.projectId });

  await db.$transaction(async (tx) => {
    await lockScope(tx, base);

    const published = await tx.policyRuleV2.count({
      where: { ...base, status: "published" },
    });
    if (published === 0) return; // not cut over yet

    const derivedSources = bridgeDerivedSources();

    const customRows = await tx.policyRuleV2.findMany({
      where: {
        ...base,
        status: "draft",
        source: { notIn: derivedSources },
        isDefault: false,
      },
      include: { identities: true, targets: true },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    const kept: KeptRule[] = customRows.map((row) => ({
      id: row.id,
      rule: reconstructOssRule(row),
    }));

    const oldRows = await tx.policyRule.findMany({
      where: { projectId: scope.projectId },
      select: OSS_OLD_RULE_SELECT,
      orderBy: { createdAt: "asc" },
    });
    const derived = translateOssBlocklistRows(oldRows as OssOldRule[]).filter(
      (r) => derivedSources.includes(r.source),
    );

    const draftPlan = interleaveOssDerived(kept, derived);

    const { rows: publishedRows } = await readCurrentPublishedGeneration(
      tx,
      base,
    );
    const keptPublished: KeptRule[] = publishedRows
      .filter((row) => !derivedSources.includes(row.source) && !row.isDefault)
      .map((row) => ({ id: row.id, rule: reconstructOssRule(row) }));
    const publishPlan = interleaveOssDerived(keptPublished, derived);

    const { rules: equipment } = translateOssEquipment(
      await readOssEquipment(tx, scope.projectId ?? ""),
    );
    const draftEquipmentStart = kept.length + derived.length;
    const publishEquipmentStart = keptPublished.length + derived.length;

    const derivedParam = derived.map((rule, i) => {
      const priority = draftPlan.derivedPriorities[i];
      const publishPriority = publishPlan.derivedPriorities[i];
      if (priority === undefined || publishPriority === undefined) {
        throw new Error(
          "oss interleave produced no priority for a derived rule",
        );
      }
      return { ...rule, priority, publishPriority };
    });
    const equipmentParam = equipment.map((r, i) => ({
      ...r,
      priority: draftEquipmentStart + i,
      publishPriority: publishEquipmentStart + i,
    }));

    await applyRematerialization(
      tx,
      base,
      [...derivedParam, ...equipmentParam],
      draftPlan.customPriorities,
      {
        publishedRows,
        publishedCustomPriorities: publishPlan.customPriorities,
      },
    );
  });
};

/** The OSS edition's coherence-bridge DI implementation. */
export const ossPolicyCoherenceBridge: PolicyCoherenceBridge = {
  rematerialize: rematerializeOssScope,
};
