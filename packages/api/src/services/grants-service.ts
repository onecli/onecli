import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { getPolicyValidator, getRuleActionGate } from "../providers";
import { assertToolIdsValid } from "../apps/app-permissions/validate";
import {
  isSessionPolicy,
  type SessionPolicyInput,
} from "../validations/policy";
import { entriesOutside } from "../lib/resource-axis";
import { loadInjectionRules } from "./policy-simulate/load-rules";
import { resolvePrincipalSet } from "./policy-simulate/principal-set";
import { orgResourceBoundary } from "./policy-reflect/org-resource-boundary";
import {
  ensureDefault,
  gatedActions,
  lockScope,
  RULE_INCLUDE,
  snapshotDraftRules,
  type PolicyRuleRow,
  type PolicyScopeBase,
} from "./policy-service";
// The pure compiler half lives in grants-compile; see its header.
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
import { requestSandboxRespawn } from "./sandbox-service";
import { bumpHomeForAgent } from "./home-sync-service";
import { logger } from "../lib/logger";
import { resolveAgentLlmCredential } from "./llm-credential-service";
import { isLlmProviderId, LLM_PROVIDER_IDS } from "../llm/registry";
import { signalWork } from "./due-work";

/**
 * The attach-model grants surface (plans/project-attach-model.md, step 2).
 *
 * A grant is INTENT stored as a canonical, `source:"grant"` policy-rule stack —
 * the engine, org floor, and reflections keep operating on ordinary rules. Per
 * (agent, connection): the uncustomized attach is ONE whole-app allow rule
 * (empty tools — future catalog tools included); a customized attach is a fixed
 * first-match stack allow(A) → allow+approval(K) → block(D = catalog − A∪K) →
 * allow+approval over the whole app (requests the catalog does not describe;
 * a block for `unlisted: "block"` catalogs, see `compileConnectionStack`). A
 * secret grant is a single allow rule. Every rule carries exactly one agent
 * identity; empty identities never inject (the inject_select law), so the
 * identity IS the attachment.
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
 * workspace rule naming org resources): the attach list spans the workspace's own
 * connections/secrets AND org-shared ones — exactly the union the gateway's
 * fenced connect-time maps load — never foreign rows.
 */

type Tx = Prisma.TransactionClient;

export interface GrantScope {
  workspaceId: string;
  organizationId: string;
}

export interface AgentGrantConnection {
  connectionId: string;
  provider: string;
  label: string | null;
  scope: "workspace" | "organization";
  access: "full" | "custom";
  allow: string[];
  ask: string[];
  /** The grant's session policy ("Resources" — repositories/folders the
   * injected credential may reach), read off the stack's allow rows; null =
   * unrestricted. */
  resources: SessionPolicyInput | null;
}

export interface AgentGrantSecret {
  secretId: string;
  name: string;
  type: string;
  scope: "workspace" | "organization";
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
  scope: "workspace",
  workspaceId: scope.workspaceId,
});

/** The attach pool: the workspace's own resources plus org-shared ones under the
 * acting org. Foreign and nonexistent ids miss this fence. */
const poolWhere = (scope: GrantScope) => ({
  OR: [
    { workspaceId: scope.workspaceId },
    { organizationId: scope.organizationId, scope: "organization" },
  ],
});

const requireAgent = async (scope: GrantScope, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId: scope.workspaceId },
    // `kind` decides whether the grant has a computer to reach — see
    // `applySecretGrantToSandbox`.
    select: { id: true, name: true, kind: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
  return agent;
};

/**
 * A SECRET grant changes what a hosted agent's container is built from, so the
 * container has to be built again.
 *
 * The spawn payload names the credential placeholder that matches the granted
 * secret's auth mode — `ANTHROPIC_API_KEY` for an API key, `CLAUDE_CODE_OAUTH_TOKEN`
 * for an OAuth token — and it is composed at DISPATCH, from the grants that
 * exist then. A grant made afterwards therefore reaches the gateway
 * immediately and the running container never at all: proven live, where the
 * agent kept answering `credential_not_found` with the grant in place until an
 * unrelated token regeneration happened to respawn it. Same declarative fix
 * regeneration already uses (`agent-service`) — mark it and let the ordinary
 * start path compose the new payload.
 *
 * Only an LLM key does this. The placeholder is derived from the granted LLM
 * key alone; a GENERIC secret is spliced at the wire like a connection, so the
 * payload is byte-identical before and after, and respawning would destroy a
 * working session to change nothing. That holds in both directions, attach and
 * detach, and matters because a new workspace secret reaches every agent at
 * once (`workspace-autoattach-service`).
 *
 * A `byo` agent has no sandbox at all, so this is a hosted-only concern.
 */
const applySecretGrantToSandbox = async (
  scope: GrantScope,
  agent: { id: string; kind: string },
  /** The secret's type; null when it is already gone (a detach after the
   * secret was deleted), which keeps the conservative respawn. */
  secretType: string | null,
): Promise<void> => {
  if (agent.kind !== "hosted") return;
  if (secretType !== null && !isLlmProviderId(secretType)) return;
  await dropStaleModelOverride(scope, agent.id);
  await requestSandboxRespawn(agent.id, scope.workspaceId);
  signalWork();
};

/**
 * Forget a model choice that belonged to a provider this agent no longer has
 * a key for (§3.10).
 *
 * The override carries the provider it was made under precisely so this is
 * possible: swapping an Anthropic key for an OpenAI one must not leave the
 * agent pointed at a Claude model its new key cannot serve. Clearing it lands
 * the agent on the new provider's default, which is a working state.
 *
 * Here rather than in `updateAgent` because this is the edit that invalidates
 * it — the granted key changing is the event, not the user editing a field.
 * `resolveAgentModel` also ignores a mismatched stamp when it reads, so a case
 * this misses degrades to the default instead of misbehaving.
 */
const dropStaleModelOverride = async (
  scope: GrantScope,
  agentId: string,
): Promise<void> => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId: scope.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      modelProvider: true,
      workspace: { select: { organizationId: true } },
    },
  });
  if (!agent?.modelProvider) return;

  const credential = await resolveAgentLlmCredential(
    { id: agent.id, workspaceId: agent.workspaceId },
    agent.workspace.organizationId,
  );
  if (credential?.provider === agent.modelProvider) return;

  await db.agent.update({
    where: { id: agentId },
    // All three together — the table's CHECK constraint rejects a half-cleared
    // override, and it would be meaningless anyway.
    data: { model: null, effort: null, modelProvider: null },
    // The bare update would read the whole row back — image_data included.
    select: { id: true },
  });
};

const requireConnection = async (scope: GrantScope, connectionId: string) => {
  const connection = await db.appConnection.findFirst({
    where: { id: connectionId, ...poolWhere(scope) },
    select: {
      id: true,
      provider: true,
      label: true,
      scope: true,
      // The policy validator deep-checks a resources set against the
      // connection (e.g. repos exist on the GitHub installation).
      metadata: true,
    },
  });
  if (!connection) throw new ServiceError("NOT_FOUND", "Connection not found.");
  return connection;
};

/** The stack's session policy in the wire shape: object conditions only (grant
 * rows never carry behavioral arrays by construction, but a hand-planted one
 * must not leak into `AgentGrantConnection.resources`). */
const grantResources = (rows: PolicyRuleRow[]): SessionPolicyInput | null => {
  const conditions = stackConditions(rows);
  return isSessionPolicy(conditions) ? conditions : null;
};

/**
 * Refuse a resource selection that reaches outside the organization's boundary
 * for this (agent, connection). The workspace narrows within what the org allows;
 * picking beyond it would compose to a smaller scope than asked for — or to
 * nothing — so say so at write time instead of letting it fail silently later.
 *
 * The runtime composition in the gateway remains the enforcement truth: an org
 * rule can change after a grant is written, and the stack must keep working
 * (narrowed) rather than needing a rewrite.
 */
const assertWithinOrgBoundary = async (
  scope: GrantScope,
  agentId: string,
  connectionId: string,
  resources: SessionPolicyInput,
): Promise<void> => {
  const orgBase = {
    scope: "organization" as const,
    organizationId: scope.organizationId,
  };
  const [orgRows, principals] = await Promise.all([
    loadInjectionRules(orgBase, "published"),
    resolvePrincipalSet(scope.workspaceId, scope.organizationId),
  ]);
  const boundary = orgResourceBoundary(
    orgRows,
    agentId,
    principals,
    connectionId,
  );
  if (!boundary) return;
  const outside = entriesOutside(resources, boundary);
  if (outside.length > 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Outside the access your organization allows for this connection: ${outside.join(", ")}`,
    );
  }
};

/** Server-side mirror of the picker's empty≡all law, plus byte-stable storage.
 *
 * Not a contradiction of `sessionPolicySchema`, which now REJECTS an empty list
 * (validations/policy.ts): the wire can no longer carry one, so this arm exists
 * for direct service callers (the converter, tests) and turns their empty
 * selection into "unrestricted" BEFORE it could ever be stored as the deny-all
 * sentinel the gateway would enforce.
 *
 * an all-empty selection clears to null (a non-null empty list is ambiguous at
 * the gateway), and list values sort — `conditionsEqual`/`stackEquals` sort
 * keys but never array elements, so an unsorted same-set re-pick would defeat
 * write idempotence. */
const normalizeResources = (
  resources: SessionPolicyInput | null,
): SessionPolicyInput | null => {
  if (resources === null) return null;
  if ("repositories" in resources) {
    return resources.repositories.length === 0
      ? null
      : { repositories: [...resources.repositories].sort() };
  }
  return resources.folders.length === 0
    ? null
    : { folders: [...resources.folders].sort() };
};

const requireSecret = async (scope: GrantScope, secretId: string) => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, ...poolWhere(scope) },
    select: { id: true, name: true, type: true, scope: true },
  });
  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found.");
  return secret;
};

/**
 * The agent's instructions list its attached connections (and each
 * host-bound app's host): re-render them when the attach set changes.
 * Best-effort, after the grant is already published; a missed bump
 * self-heals at the agent's next boot.
 */
const refreshAgentHome = (agentId: string): Promise<void> =>
  bumpHomeForAgent(agentId).catch((err: unknown) => {
    logger.warn({ err, agentId }, "grant change: agent home refresh failed");
  });

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

type GrantCreate = {
  rule: CompiledRule;
  target: Prisma.PolicyRuleTargetCreateWithoutRuleInput;
  agentId: string;
};

const grantName = (agentName: string, resourceLabel: string) =>
  `Grant: ${agentName} · ${resourceLabel}`;

const connectionTarget = (
  connectionId: string,
  rule: CompiledRule,
): Prisma.PolicyRuleTargetCreateWithoutRuleInput => ({
  kind: "connection",
  appConnection: { connect: { id: connectionId } },
  appTools: rule.tools,
});

const secretTarget = (
  secretId: string,
): Prisma.PolicyRuleTargetCreateWithoutRuleInput => ({
  kind: "secret",
  secret: { connect: { id: secretId } },
});

/** Append `creates` at the tail priority band (custom rules keep first-match
 * precedence until step 6). Callers hold the scope lock. */
const appendGrantRules = async (
  tx: Tx,
  scopeBase: PolicyScopeBase,
  userId: string | null,
  creates: GrantCreate[],
): Promise<string[]> => {
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
  return ruleIds;
};

/** Publish the whole draft as a fresh generation, so a grant is enforced the
 * moment the request returns. Callers hold the scope lock. */
const publishDraft = async (
  tx: Tx,
  scopeBase: PolicyScopeBase,
  userId: string | null,
): Promise<number> => {
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
  return generation;
};

/**
 * Replace the draft rows matched by `deleteWhere` with `creates`, then publish
 * the whole draft, in one transaction under the per-scope advisory lock.
 */
const replaceAndPublish = async (
  scope: GrantScope,
  userId: string | null,
  deleteWhere: Prisma.PolicyRuleV2WhereInput,
  creates: GrantCreate[],
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
    const ruleIds = await appendGrantRules(tx, scopeBase, userId, creates);
    const generation = await publishDraft(tx, scopeBase, userId);
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
    connections: connections.map((c) => {
      const stack = byConnection.get(c.id) ?? [];
      return {
        connectionId: c.id,
        provider: c.provider,
        label: c.label,
        scope: c.scope === "organization" ? "organization" : "workspace",
        ...stackToGrant(stack),
        resources: grantResources(stack),
      };
    }),
    secrets: secrets.map((s) => ({
      secretId: s.id,
      name: s.name,
      type: s.type,
      scope: s.scope === "organization" ? "organization" : "workspace",
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
  }

  const nameBase = grantName(
    agent.name,
    connection.label ?? connection.provider,
  );
  const existing = await readGrantRows(db, scope, { agentId, connectionId });
  // The resources tri-state (validations/grants.ts): ABSENT preserves whatever
  // the existing stack carries — the step-5 conversion's carried policies and
  // every tools-only dialog save — while NULL clears and an OBJECT sets. The
  // preserve read sits deliberately outside the write transaction (the same
  // window the step-5 carry always had): a tools-only save racing a concurrent
  // resources save can lose the newer restriction — accepted.
  let conditions: Prisma.JsonValue | null;
  if (input.resources === undefined) {
    conditions = stackConditions(existing);
  } else {
    const resources = normalizeResources(input.resources);
    if (resources !== null) {
      // An explicit SET runs the edition's validator: EE deep-checks the shape
      // against the provider and team-gates the entitlement; OSS rejects every
      // session policy with its 422 lock. Clearing and preserving are never
      // gated — removing a restriction must not require an entitlement.
      await getPolicyValidator().validate(
        scope.organizationId,
        connection.provider,
        connection.metadata as Record<string, unknown> | null,
        resources,
      );
      await assertWithinOrgBoundary(scope, agentId, connectionId, resources);
    }
    conditions = resources;
  }
  const desired = compileConnectionStack(
    nameBase,
    connection.provider,
    input,
    conditions,
  );
  if (desired.some((rule) => rule.requireApproval)) {
    // Same law as the rule CRUD: approval-modified rules are plan-gated at
    // write time (publish re-asserts over the whole draft — an ungated write
    // here would brick the scope's next publish, not dodge the entitlement).
    // Keyed on the COMPILED stack, not `input.ask`: a customized stack's
    // terminal needs approval even when no tool does.
    await getRuleActionGate().assertAllowed(
      base(scope),
      gatedActions({ requireApproval: true }),
    );
  }
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
      target: connectionTarget(connectionId, rule),
    })),
  );
  await refreshAgentHome(agentId);
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
  await refreshAgentHome(agent.id);
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
    grantName(agent.name, secret.name),
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
      target: secretTarget(secretId),
    })),
  );
  await applySecretGrantToSandbox(scope, agent, secret.type);
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
  // Revoking an LLM key moves the payload too: losing the only OAuth secret
  // flips the placeholder back to `ANTHROPIC_API_KEY`, and a container still
  // advertising the old one would keep sending a header the gateway no longer
  // fills. No fence on this read: the detach itself needs none either.
  const secret = await db.secret.findUnique({
    where: { id: secretId },
    select: { type: true },
  });
  await applySecretGrantToSandbox(scope, agent, secret?.type ?? null);
  return {
    grants: await getAgentGrants(scope, agentId),
    changed: true,
    ruleIds: [],
    generation,
  };
};

/** Default grants for `addDefaultGrants`: (agent × connection) whole-app
 * attaches and (agent × secret) attaches. */
export interface DefaultGrantRequest {
  agentIds: string[];
  connectionIds: string[];
  secretIds: string[];
}

/** The (agent, resource) pairs `addDefaultGrants` actually wrote. */
export interface DefaultGrantResult {
  connections: { agentId: string; connectionId: string }[];
  secrets: { agentId: string; secretId: string }[];
}

/**
 * Attach many (agent, resource) pairs at once, the workspace auto-attach's
 * writer. ONE transaction and ONE publish however many pairs, where the
 * per-pair writers above would publish once per pair: a new agent in a
 * workspace with N connections would otherwise burn N generations (pushing
 * every rollback target out of the retention window) and N round-trips through
 * the scope lock.
 *
 * ADD-ONLY: a pair that already has any stack is left exactly as it is, so a
 * customized grant is never flattened back to full access. Uncustomized
 * whole-app attaches only, exactly what the dialog toggle writes, so turning
 * one off is the same single detach.
 *
 * Fenced like every grant write: agents must be the workspace's own, and
 * resources must be in the workspace+org pool; anything else is silently
 * skipped (a vanished row is a no-op, never an error).
 *
 * GENERIC secrets only. An LLM key changes a hosted agent's spawn payload, so
 * its grant needs the per-pair writer's respawn; it is refused here rather than
 * granted without one.
 */
export const addDefaultGrants = async (
  scope: GrantScope,
  request: DefaultGrantRequest,
  userId: string | null,
): Promise<DefaultGrantResult> => {
  const empty: DefaultGrantResult = { connections: [], secrets: [] };
  if (request.agentIds.length === 0) return empty;
  const [connections, secrets] = await Promise.all([
    request.connectionIds.length > 0
      ? db.appConnection.findMany({
          where: { id: { in: request.connectionIds }, ...poolWhere(scope) },
          select: { id: true, provider: true, label: true },
        })
      : Promise.resolve([]),
    request.secretIds.length > 0
      ? db.secret.findMany({
          where: {
            id: { in: request.secretIds },
            ...poolWhere(scope),
            type: { notIn: LLM_PROVIDER_IDS },
          },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  if (connections.length === 0 && secrets.length === 0) return empty;

  const scopeBase = base(scope);
  const result = await db.$transaction(
    async (tx) => {
      await lockScope(tx, scopeBase);
      // The agents and their existing stacks are read UNDER the lock. An agent
      // delete holds this lock until it commits, so no agent here can vanish
      // before the append (one that did would fail its identity connect and
      // cost every other agent the grant), and no concurrent grant can slip a
      // stack in between this check and the append.
      const agents = await tx.agent.findMany({
        where: { id: { in: request.agentIds }, workspaceId: scope.workspaceId },
        select: { id: true, name: true },
      });
      const existing = await tx.policyRuleV2.findMany({
        where: {
          ...scopeBase,
          status: "draft",
          source: GRANT_SOURCE,
          identities: { some: { agentId: { in: agents.map((a) => a.id) } } },
        },
        select: {
          identities: { select: { agentId: true } },
          targets: { select: { appConnectionId: true, secretId: true } },
        },
      });
      const held = new Set(
        existing.flatMap((row) =>
          row.identities.flatMap((i) =>
            row.targets.map(
              (t) => `${i.agentId}:${t.appConnectionId ?? t.secretId}`,
            ),
          ),
        ),
      );

      const written: DefaultGrantResult = { connections: [], secrets: [] };
      const creates: GrantCreate[] = [];
      for (const agent of agents) {
        for (const connection of connections) {
          if (held.has(`${agent.id}:${connection.id}`)) continue;
          const name = grantName(
            agent.name,
            connection.label ?? connection.provider,
          );
          for (const rule of compileConnectionStack(name, connection.provider, {
            access: "full",
          })) {
            creates.push({
              rule,
              agentId: agent.id,
              target: connectionTarget(connection.id, rule),
            });
          }
          written.connections.push({
            agentId: agent.id,
            connectionId: connection.id,
          });
        }
        for (const secret of secrets) {
          if (held.has(`${agent.id}:${secret.id}`)) continue;
          for (const rule of compileSecretGrant(
            grantName(agent.name, secret.name),
          )) {
            creates.push({
              rule,
              agentId: agent.id,
              target: secretTarget(secret.id),
            });
          }
          written.secrets.push({ agentId: agent.id, secretId: secret.id });
        }
      }
      if (creates.length === 0) return written;
      await appendGrantRules(tx, scopeBase, userId, creates);
      await publishDraft(tx, scopeBase, userId);
      return written;
    },
    // One row per pair: a large workspace's fan-out can outlast Prisma's 5s
    // default interactive-transaction timeout (the backfill precedent).
    { timeout: 60_000, maxWait: 10_000 },
  );
  // Only connection grants reach an agent's instructions; generic secrets are
  // spliced at the wire and never rendered.
  const touched = new Set(result.connections.map((c) => c.agentId));
  await Promise.all([...touched].map(refreshAgentHome));
  return result;
};
