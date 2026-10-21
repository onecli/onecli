import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { getPolicyValidator, getRuleActionGate } from "../providers";
import {
  assertToolIdsValid,
  assertUnlistedChoicesValid,
} from "../apps/app-permissions/validate";
import {
  isSessionPolicy,
  type SessionPolicyInput,
} from "../validations/policy";
import { canonicalPolicy, entriesOutside } from "../lib/resource-axis";
import { loadInjectionRules } from "./policy-simulate/load-rules";
import { resolvePrincipalSet } from "./policy-simulate/principal-set";
import { orgResourceBoundary } from "./policy-reflect/org-resource-boundary";
import { grantedSecretSelection } from "./policy-reflect/injection";
import {
  gatedActions,
  lockScope,
  publishDraftInTx,
  RULE_INCLUDE,
  type PolicyRuleRow,
  type PolicyScopeBase,
} from "./policy-service";
// The pure compiler half lives in grants-compile; see its header.
import {
  compileConnectionStack,
  compileSecretGrant,
  conditionsCreateInput,
  defaultConnectionGrant,
  GRANT_SOURCE,
  stackConditions,
  stackEquals,
  stackToGrant,
  withStoredUnlisted,
  type CompiledRule,
} from "./grants-compile";
import type {
  ConnectionGrantInput,
  ConnectionGrantRequest,
  UnlistedChoice,
} from "../validations/grants";
import { requestSandboxRespawn } from "./sandbox-service";
import { bumpHomeForAgent } from "./home-sync-service";
import { logger } from "../lib/logger";
import { resolveAgentLlmCredential } from "./llm-credential-service";
import { isLlmProviderId } from "../llm/registry";
import { signalWork } from "./due-work";

/**
 * The attach-model grants surface (plans/project-attach-model.md, step 2).
 *
 * A grant is INTENT stored as a canonical, `source:"grant"` policy-rule stack —
 * the engine, org floor, and reflections keep operating on ordinary rules. Per
 * (agent, connection): full access is ONE whole-app allow rule (empty tools,
 * so future catalog tools are included); a customized attach, which is also
 * what a new attach writes (`defaultConnectionGrant`), is a fixed first-match
 * stack allow(A) → allow+approval(K) → block(D = catalog − A∪K) → the
 * catch-alls over the whole app (requests the catalog does not describe, see
 * `compileConnectionStack`). A secret grant is a single allow rule. Every
 * rule carries exactly one agent identity; empty identities never inject (the
 * inject_select law), so the identity IS the attachment.
 *
 * Writes follow the blocklist-service precedent: one transaction under the
 * per-scope advisory lock — delete the old stack, append the new one at the
 * tail priority band (custom rules keep first-match precedence until step 6),
 * then publish atomically (`publishDraftInTx`), so a grant is enforced the
 * moment the request returns. The compiler is idempotent (an identical
 * desired state writes nothing) and repairs any hand-edit drift on the next
 * write by construction (delete-then-recompile).
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
  /** Requests the catalog does not describe: GET/HEAD ("All other reads")
   * and the rest ("All other writes"). "allow" on a full grant. */
  otherReads: UnlistedChoice;
  otherWrites: UnlistedChoice;
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
    otherReads: UnlistedChoice;
    otherWrites: UnlistedChoice;
    /** The grant's session policy, as on `AgentGrantConnection`. */
    resources: SessionPolicyInput | null;
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
 * detach, and matters because a custom secret is often switched on for many
 * agents in a row (its "choose agents" window).
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
  // The "All other reads"/"All other writes" split's method narrowing
  // (`GET,HEAD` / `!GET,HEAD`); absent on every other row (NULL = any
  // method, the gateway's reading of every older row).
  ...(rule.method ? { method: rule.method } : {}),
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
    const { generation } = await publishDraftInTx(tx, scopeBase, userId);
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
        ...stackToGrant(stack, c.provider),
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
  const connection = await requireConnection(scope, connectionId);
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
      ...stackToGrant(stack, connection.provider),
      resources: grantResources(stack),
    })),
  };
};

export const setConnectionGrant = async (
  scope: GrantScope,
  agentId: string,
  connectionId: string,
  request: ConnectionGrantRequest,
  userId: string | null,
): Promise<GrantMutationResult> => {
  const [agent, connection] = await Promise.all([
    requireAgent(scope, agentId),
    requireConnection(scope, connectionId),
  ]);
  // `default` is the attach toggles' request, resolved here per provider to
  // the shape every new attach gets (reads allowed, writes and requests
  // outside the tool list needing approval). It names its catch-alls
  // explicitly, so it never inherits a stored choice; `resources` keeps its
  // tri-state.
  const input: ConnectionGrantInput =
    request.access === "default"
      ? {
          ...defaultConnectionGrant(connection.provider),
          resources: request.resources,
        }
      : request;
  if (input.access === "custom") {
    assertToolIdsValid(connection.provider, [...input.allow, ...input.ask]);
  }

  const nameBase = grantName(
    agent.name,
    connection.label ?? connection.provider,
  );
  const existing = await readGrantRows(db, scope, { agentId, connectionId });
  // Absent catch-all choices keep what the stack already says (the same
  // preserve law as `resources` below); checked AFTER the merge, so a stored
  // value is held to the same rules as a sent one.
  const grant = withStoredUnlisted(input, existing, connection.provider);
  if (grant.access === "custom") {
    assertUnlistedChoicesValid(connection.provider, [
      grant.otherReads,
      grant.otherWrites,
    ]);
  }
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
    // The picker's empty≡all law plus byte-stable storage. Not a
    // contradiction of `sessionPolicySchema`, which REJECTS an empty list: the
    // wire can't carry one, so this protects direct service callers (the
    // converter, tests) from storing the gateway's deny-all sentinel.
    const resources = canonicalPolicy(input.resources);
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
    grant,
    conditions,
  );
  if (desired.some((rule) => rule.requireApproval)) {
    // Same law as the rule CRUD: approval-modified rules are plan-gated at
    // write time, and the write is what goes live (the in-tx publish gates
    // nothing of its own).
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

/**
 * Give ONE agent the product-default attach on ONE connection
 * (`defaultConnectionGrant`, exactly what the attach toggles write), unless it
 * already holds a stack for it. The connect-from-an-agent writer
 * (`agent-connect-grant-service`): a connection added from an agent's context
 * is on for that agent from the start.
 *
 * ADD-ONLY, unlike `setConnectionGrant`: an existing stack (a customized one
 * included) is left exactly as it is, so re-adding an account the agent
 * already narrowed never flattens it back to the default. The existence check
 * and the append run under the scope lock, so a concurrent grant write can't
 * slip a stack in between them. Nothing written means nothing published.
 *
 * Fenced like every grant write: the agent must be the workspace's own and
 * the connection in the workspace+org pool (404 otherwise).
 */
export const attachDefaultConnectionGrant = async (
  scope: GrantScope,
  agentId: string,
  connectionId: string,
  userId: string | null,
): Promise<{ changed: boolean }> => {
  const [agent, connection] = await Promise.all([
    requireAgent(scope, agentId),
    requireConnection(scope, connectionId),
  ]);
  const desired = compileConnectionStack(
    grantName(agent.name, connection.label ?? connection.provider),
    connection.provider,
    defaultConnectionGrant(connection.provider),
  );
  // The default attach's catch-alls need approval: the same write-time gate
  // as `setConnectionGrant`, checked before the lock (it reads the plan).
  if (desired.some((rule) => rule.requireApproval)) {
    await getRuleActionGate().assertAllowed(
      base(scope),
      gatedActions({ requireApproval: true }),
    );
  }

  const scopeBase = base(scope);
  const changed = await db.$transaction(async (tx) => {
    await lockScope(tx, scopeBase);
    const existing = await readGrantRows(tx, scope, { agentId, connectionId });
    if (existing.length > 0) return false;
    await appendGrantRules(
      tx,
      scopeBase,
      userId,
      desired.map((rule) => ({
        rule,
        agentId,
        target: connectionTarget(connectionId, rule),
      })),
    );
    await publishDraftInTx(tx, scopeBase, userId);
    return true;
  });
  if (changed) await refreshAgentHome(agentId);
  return { changed };
};

/** One agent's standing on one secret: the per-agent rows of the secret's
 * "choose agents" window. */
export interface SecretAgentAccessEntry {
  agentId: string;
  name: string;
  /** A workspace grant (the switch's own state): detachable. */
  granted: boolean;
  /** Injected by an ORG rule with no workspace grant: on, and locked. */
  orgGranted: boolean;
}

export interface SecretAgentAccess {
  secretId: string;
  agents: SecretAgentAccessEntry[];
}

/**
 * Every agent of the workspace against one secret, the reverse view the
 * custom connection's "choose agents" window toggles over (the secret twin of
 * the connection's agent-access dialog). `orgGranted` follows the injection
 * law the agent page's Custom tab reads (`grantedSecretSelection` over the
 * PUBLISHED org rules), so a switch here never disagrees with that tab.
 *
 * Constant query count however many agents: one agent list, one grant-row
 * read, one org rule load and one principal-set resolution (agent-independent
 * by design), then a pure in-memory walk per agent.
 */
export const getSecretAgentAccess = async (
  scope: GrantScope,
  secretId: string,
): Promise<SecretAgentAccess> => {
  const secret = await requireSecret(scope, secretId);
  const [agents, grantRows, orgRows, principals] = await Promise.all([
    db.agent.findMany({
      where: { workspaceId: scope.workspaceId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    readGrantRows(db, scope, { secretId }),
    loadInjectionRules(
      { scope: "organization", organizationId: scope.organizationId },
      "published",
    ),
    resolvePrincipalSet(scope.workspaceId, scope.organizationId),
  ]);
  const grantedAgentIds = new Set(
    grantRows.flatMap((row) => row.identities.map((i) => i.agentId)),
  );
  const level = secret.scope === "organization" ? "organization" : "workspace";
  return {
    secretId,
    agents: agents.map((agent) => {
      const granted = grantedAgentIds.has(agent.id);
      const viaOrg = grantedSecretSelection(orgRows, agent.id, principals);
      return {
        agentId: agent.id,
        name: agent.name,
        granted,
        orgGranted:
          !granted &&
          (viaOrg.ids.includes(secretId) || viaOrg.levels.has(level)),
      };
    }),
  };
};
