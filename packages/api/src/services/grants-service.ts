import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { getRuleActionGate } from "../providers";
import { assertToolIdsValid } from "../apps/app-permissions/validate";
import {
  ensureDefault,
  gatedActions,
  lockScope,
  RULE_INCLUDE,
  snapshotDraftRules,
  type PolicyRuleRow,
  type PolicyScopeBase,
} from "./policy-service";
// The pure compiler half lives in grants-compile so the step-5 converter
// (`policy-grant-conversion/`) writes byte-identical stacks; see its header.
import {
  compileConnectionStack,
  compileSecretGrant,
  conditionsCreateInput,
  GRANT_SOURCE,
  stackConditions,
  stackEquals,
  stackToGrant,
  type CompiledRule,
} from "./grants-compile";
import type { ConnectionGrantInput } from "../validations/grants";

/**
 * The attach-model grants surface (plans/project-attach-model.md, step 2).
 *
 * A grant is INTENT stored as a canonical, `source:"grant"` policy-rule stack —
 * the engine, org floor, and reflections keep operating on ordinary rules. Per
 * (agent, connection): the uncustomized attach is ONE whole-app allow rule
 * (empty tools — future catalog tools included); a customized attach is a fixed
 * first-match stack allow(A) → allow+approval(K) → block(D = catalog − A∪K) →
 * terminal block (empty tools — new catalog tools arrive as Never). A secret
 * grant is a single allow rule. Every rule carries exactly one agent identity;
 * empty identities never inject (the inject_select law), so the identity IS the
 * attachment.
 *
 * Writes follow the blocklist-service precedent: one transaction under the
 * per-scope advisory lock — delete the old stack, append the new one at the
 * tail priority band (custom rules keep first-match precedence until step 6),
 * then publish atomically (`ensureDefault` + `snapshotDraftRules`), so a grant
 * is enforced the moment the request returns. The compiler is idempotent (an
 * identical desired state writes nothing) and repairs any hand-edit drift on
 * the next write by construction (delete-then-recompile).
 *
 * Fencing deliberately DIFFERS from `assertTargetsValid` (which forbids a
 * project rule naming org resources): the attach list spans the project's own
 * connections/secrets AND org-shared ones — exactly the union the gateway's
 * fenced connect-time maps load — never foreign or partner rows.
 */

type Tx = Prisma.TransactionClient;

export interface GrantScope {
  projectId: string;
  organizationId: string;
}

export interface AgentGrantConnection {
  connectionId: string;
  provider: string;
  label: string | null;
  scope: "project" | "organization";
  access: "full" | "custom";
  allow: string[];
  ask: string[];
}

export interface AgentGrantSecret {
  secretId: string;
  name: string;
  type: string;
  scope: "project" | "organization";
}

export interface AgentGrants {
  agentId: string;
  /** Always `"grants"` since step 7 (the gateway is grants-only); the `"all"`
   * arm stays for wire compat and narrows away with the column in step 8. */
  mode: "all" | "grants";
  connections: AgentGrantConnection[];
  secrets: AgentGrantSecret[];
}

export interface ConnectionGrants {
  connectionId: string;
  agents: {
    agentId: string;
    access: "full" | "custom";
    allow: string[];
    ask: string[];
  }[];
}

export interface GrantMutationResult {
  grants: AgentGrants;
  /** False when the desired state already existed — nothing was written or
   * published (the idempotent no-op). */
  changed: boolean;
  ruleIds: string[];
  generation: number | null;
}

const base = (scope: GrantScope): PolicyScopeBase => ({
  scope: "project",
  projectId: scope.projectId,
});

/** The attach pool: the project's own resources plus org-shared ones under the
 * acting org. Foreign, partner-scoped, and nonexistent ids miss this fence. */
const poolWhere = (scope: GrantScope) => ({
  OR: [
    { projectId: scope.projectId },
    { organizationId: scope.organizationId, scope: "organization" },
  ],
});

const requireAgent = async (scope: GrantScope, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId: scope.projectId },
    select: { id: true, name: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
  return agent;
};

const requireConnection = async (scope: GrantScope, connectionId: string) => {
  const connection = await db.appConnection.findFirst({
    where: { id: connectionId, ...poolWhere(scope) },
    select: { id: true, provider: true, label: true, scope: true },
  });
  if (!connection) throw new ServiceError("NOT_FOUND", "Connection not found.");
  return connection;
};

const requireSecret = async (scope: GrantScope, secretId: string) => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, ...poolWhere(scope) },
    select: { id: true, name: true, type: true, scope: true },
  });
  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found.");
  return secret;
};

// ── Stack reads ──────────────────────────────────────────────────────────────

/** The agent's draft grant rows, optionally narrowed to one connection or
 * secret. A grant rule always has exactly one identity and one target, so this
 * shape identifies stacks precisely. */
const readGrantRows = (
  client: Tx | typeof db,
  scope: GrantScope,
  where: {
    agentId?: string;
    connectionId?: string;
    secretId?: string;
  },
): Promise<PolicyRuleRow[]> =>
  client.policyRuleV2.findMany({
    where: {
      ...base(scope),
      status: "draft",
      source: GRANT_SOURCE,
      ...(where.agentId
        ? { identities: { some: { agentId: where.agentId } } }
        : {}),
      ...(where.connectionId
        ? { targets: { some: { appConnectionId: where.connectionId } } }
        : {}),
      ...(where.secretId
        ? { targets: { some: { secretId: where.secretId } } }
        : {}),
    },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });

// ── The atomic write core ────────────────────────────────────────────────────

/**
 * Replace the draft rows matched by `deleteWhere` with `creates` at the tail
 * priority band, then publish the whole draft — one transaction under the
 * per-scope advisory lock. `creates` build their own identity/target rows.
 */
const replaceAndPublish = async (
  scope: GrantScope,
  userId: string | null,
  deleteWhere: Prisma.PolicyRuleV2WhereInput,
  creates: {
    rule: CompiledRule;
    target: Prisma.PolicyRuleTargetCreateWithoutRuleInput;
    agentId: string;
  }[],
): Promise<{ ruleIds: string[]; generation: number }> => {
  const scopeBase = base(scope);
  return db.$transaction(async (tx) => {
    await lockScope(tx, scopeBase);
    await tx.policyRuleV2.deleteMany({
      where: {
        ...scopeBase,
        status: "draft",
        source: GRANT_SOURCE,
        ...deleteWhere,
      },
    });
    const tail = await tx.policyRuleV2.aggregate({
      where: { ...scopeBase, status: "draft", isDefault: false },
      _max: { priority: true },
    });
    let priority = (tail._max.priority ?? 0) + 1;
    const ruleIds: string[] = [];
    for (const { rule, target, agentId } of creates) {
      const created = await tx.policyRuleV2.create({
        data: {
          ...scopeBase,
          status: "draft",
          generation: 0,
          priority: priority++,
          isDefault: false,
          enabled: true,
          source: GRANT_SOURCE,
          logicalId: randomUUID(),
          name: rule.name,
          action: rule.action,
          requireApproval: rule.requireApproval,
          conditions: conditionsCreateInput(rule.conditions),
          createdByUserId: userId,
          identities: { create: [{ agent: { connect: { id: agentId } } }] },
          targets: { create: [target] },
        },
        select: { id: true },
      });
      ruleIds.push(created.id);
    }
    await ensureDefault(tx, scopeBase);
    const draftRules = await tx.policyRuleV2.findMany({
      where: { ...scopeBase, status: "draft" },
      include: RULE_INCLUDE,
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    const { generation } = await snapshotDraftRules(
      tx,
      scopeBase,
      draftRules,
      userId,
    );
    return { ruleIds, generation };
  });
};

// ── Public surface ───────────────────────────────────────────────────────────

export const getAgentGrants = async (
  scope: GrantScope,
  agentId: string,
): Promise<AgentGrants> => {
  const agent = await requireAgent(scope, agentId);
  const rows = await readGrantRows(db, scope, { agentId });

  const byConnection = new Map<string, PolicyRuleRow[]>();
  const secretIds: string[] = [];
  for (const row of rows) {
    const target = row.targets[0];
    if (!target) continue; // orphaned by an FK cascade — inert, skip
    if (target.kind === "connection" && target.appConnectionId) {
      const stack = byConnection.get(target.appConnectionId) ?? [];
      stack.push(row);
      byConnection.set(target.appConnectionId, stack);
    } else if (target.kind === "secret" && target.secretId) {
      secretIds.push(target.secretId);
    }
  }

  const [connections, secrets] = await Promise.all([
    byConnection.size
      ? db.appConnection.findMany({
          where: { id: { in: [...byConnection.keys()] }, ...poolWhere(scope) },
          select: { id: true, provider: true, label: true, scope: true },
        })
      : Promise.resolve([]),
    secretIds.length
      ? db.secret.findMany({
          where: { id: { in: secretIds }, ...poolWhere(scope) },
          select: { id: true, name: true, type: true, scope: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    agentId: agent.id,
    // Constant since step 7 — the union's "all" arm stays for wire compat and
    // narrows away with the column in step 8.
    mode: "grants",
    connections: connections.map((c) => ({
      connectionId: c.id,
      provider: c.provider,
      label: c.label,
      scope: c.scope === "organization" ? "organization" : "project",
      ...stackToGrant(byConnection.get(c.id) ?? []),
    })),
    secrets: secrets.map((s) => ({
      secretId: s.id,
      name: s.name,
      type: s.type,
      scope: s.scope === "organization" ? "organization" : "project",
    })),
  };
};

export const getConnectionGrants = async (
  scope: GrantScope,
  connectionId: string,
): Promise<ConnectionGrants> => {
  await requireConnection(scope, connectionId);
  const rows = await readGrantRows(db, scope, { connectionId });
  const byAgent = new Map<string, PolicyRuleRow[]>();
  for (const row of rows) {
    const agentId = row.identities[0]?.agentId;
    if (!agentId) continue;
    const stack = byAgent.get(agentId) ?? [];
    stack.push(row);
    byAgent.set(agentId, stack);
  }
  return {
    connectionId,
    agents: [...byAgent.entries()].map(([agentId, stack]) => ({
      agentId,
      ...stackToGrant(stack),
    })),
  };
};

export const setConnectionGrant = async (
  scope: GrantScope,
  agentId: string,
  connectionId: string,
  input: ConnectionGrantInput,
  userId: string | null,
): Promise<GrantMutationResult> => {
  const [agent, connection] = await Promise.all([
    requireAgent(scope, agentId),
    requireConnection(scope, connectionId),
  ]);
  if (input.access === "custom") {
    assertToolIdsValid(connection.provider, [...input.allow, ...input.ask]);
    if (input.ask.length > 0) {
      // Same law as the rule CRUD: approval-modified rules are plan-gated at
      // write time (publish re-asserts over the whole draft — an ungated write
      // here would brick the scope's next publish, not dodge the entitlement).
      await getRuleActionGate().assertAllowed(
        base(scope),
        gatedActions({ requireApproval: true }),
      );
    }
  }

  const nameBase = `Grant: ${agent.name} · ${connection.label ?? connection.provider}`;
  const existing = await readGrantRows(db, scope, { agentId, connectionId });
  // A session policy on the existing stack (carried there by the step-5
  // conversion — the dialog cannot author one) survives every re-save: the
  // recompiled stack re-carries it instead of silently dropping the
  // restriction.
  const desired = compileConnectionStack(
    nameBase,
    connection.provider,
    input,
    stackConditions(existing),
  );
  if (stackEquals(existing, desired)) {
    return {
      grants: await getAgentGrants(scope, agentId),
      changed: false,
      ruleIds: existing.map((r) => r.id),
      generation: null,
    };
  }

  const { ruleIds, generation } = await replaceAndPublish(
    scope,
    userId,
    {
      identities: { some: { agentId } },
      targets: { some: { appConnectionId: connectionId } },
    },
    desired.map((rule) => ({
      rule,
      agentId,
      target: {
        kind: "connection",
        appConnection: { connect: { id: connectionId } },
        appTools: rule.tools,
      },
    })),
  );
  return {
    grants: await getAgentGrants(scope, agentId),
    changed: true,
    ruleIds,
    generation,
  };
};

export const removeConnectionGrant = async (
  scope: GrantScope,
  agentId: string,
  connectionId: string,
  userId: string | null,
): Promise<GrantMutationResult> => {
  const agent = await requireAgent(scope, agentId);
  // Deliberately NO connection fence: detaching must work for a connection
  // that was deleted meanwhile (its stack rows survive the FK cascade only
  // when other targets exist — matching rows here mean live intent to clear).
  const existing = await readGrantRows(db, scope, {
    agentId: agent.id,
    connectionId,
  });
  if (existing.length === 0) {
    return {
      grants: await getAgentGrants(scope, agentId),
      changed: false,
      ruleIds: [],
      generation: null,
    };
  }
  const { generation } = await replaceAndPublish(
    scope,
    userId,
    {
      identities: { some: { agentId } },
      targets: { some: { appConnectionId: connectionId } },
    },
    [],
  );
  return {
    grants: await getAgentGrants(scope, agentId),
    changed: true,
    ruleIds: [],
    generation,
  };
};

export const setSecretGrant = async (
  scope: GrantScope,
  agentId: string,
  secretId: string,
  userId: string | null,
): Promise<GrantMutationResult> => {
  const [agent, secret] = await Promise.all([
    requireAgent(scope, agentId),
    requireSecret(scope, secretId),
  ]);
  const desired: CompiledRule[] = compileSecretGrant(
    `Grant: ${agent.name} · ${secret.name}`,
  );
  const existing = await readGrantRows(db, scope, { agentId, secretId });
  if (stackEquals(existing, desired)) {
    return {
      grants: await getAgentGrants(scope, agentId),
      changed: false,
      ruleIds: existing.map((r) => r.id),
      generation: null,
    };
  }
  const { ruleIds, generation } = await replaceAndPublish(
    scope,
    userId,
    {
      identities: { some: { agentId } },
      targets: { some: { secretId } },
    },
    desired.map((rule) => ({
      rule,
      agentId,
      target: { kind: "secret", secret: { connect: { id: secretId } } },
    })),
  );
  return {
    grants: await getAgentGrants(scope, agentId),
    changed: true,
    ruleIds,
    generation,
  };
};

export const removeSecretGrant = async (
  scope: GrantScope,
  agentId: string,
  secretId: string,
  userId: string | null,
): Promise<GrantMutationResult> => {
  const agent = await requireAgent(scope, agentId);
  const existing = await readGrantRows(db, scope, {
    agentId: agent.id,
    secretId,
  });
  if (existing.length === 0) {
    return {
      grants: await getAgentGrants(scope, agentId),
      changed: false,
      ruleIds: [],
      generation: null,
    };
  }
  const { generation } = await replaceAndPublish(
    scope,
    userId,
    {
      identities: { some: { agentId } },
      targets: { some: { secretId } },
    },
    [],
  );
  return {
    grants: await getAgentGrants(scope, agentId),
    changed: true,
    ruleIds: [],
    generation,
  };
};
