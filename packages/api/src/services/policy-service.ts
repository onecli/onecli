import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { isOnpremEdition } from "../lib/policy-flags";
import { type ResourceScope } from "./resource-scope";
import { getPolicyValidator, getRuleActionGate } from "../providers";
import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
  PolicyIdentityInput,
  PolicyTargetInput,
} from "../validations/policy";
import { isSessionPolicy } from "../validations/policy";
import { GRANT_SOURCE } from "./grants-compile";

// ── Unified policy engine service (policy_rules_v2) ─────────────────────────
// CRUD + reorder over the priority-ordered, first-match rule model. Each scope
// keeps a draft (working copy) and published snapshots; the gateway reads only
// the active published generation. Every write here publishes the draft in the
// same locked transaction (`publishDraftInTx`), so an edit is enforced the
// moment the request returns. There is no staged state.

type PolicyStatus = "draft" | "published";

export const RULE_INCLUDE = {
  identities: true,
  targets: true,
} satisfies Prisma.PolicyRuleV2Include;

type RuleRow = Prisma.PolicyRuleV2GetPayload<{ include: typeof RULE_INCLUDE }>;

/** A full policy rule row (identities + targets included) — the currency of the
 * publish/generation machinery. */
export type PolicyRuleRow = RuleRow;

export interface PolicyRuleDto {
  id: string;
  scope: string;
  status: string;
  generation: number;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  /** Generation-stable identity (a publish copies it onto the snapshot) — the
   * key the editor diffs draft vs published rules by; row `id` regenerates. */
  logicalId: string;
  // Rule origin — the editor treats "custom" as editable (post-adoption this
  // includes the former app_permission rules, re-tagged custom at the editing
  // cutover) and shows the remaining derived sources (blocklist/equipment, or
  // app_permission pre-cutover) read-only.
  source: string;
  name: string;
  description: string | null;
  action: string;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  requireApproval: boolean;
  conditions: Prisma.JsonValue;
  identities: PolicyIdentityInput[];
  targets: PolicyTargetDto[];
  createdAt: Date;
}

// Response targets mirror the input union but loosen `method` to a plain string
// (it came from the validated enum on write; the response reflects storage).
export type PolicyTargetDto =
  | {
      kind: "app";
      provider: string;
      tools: string[];
      connectionScope: "organization" | "workspace" | null;
    }
  | { kind: "connection"; connectionId: string; tools: string[] }
  | {
      kind: "secret";
      secretId: string | null;
      secretScope: "organization" | "workspace" | null;
    }
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    };

// A rule is scoped to exactly one of org/workspace (mirrors the scope_shape CHECK);
// the routes always pass exactly one.
export const policyScope = (scope: ResourceScope) => {
  if (scope.organizationId) {
    return {
      scope: "organization" as const,
      organizationId: scope.organizationId,
    };
  }
  if (scope.workspaceId) {
    return { scope: "workspace" as const, workspaceId: scope.workspaceId };
  }
  throw new ServiceError(
    "BAD_REQUEST",
    "A policy scope requires a workspace or organization.",
  );
};

export type PolicyScopeBase = ReturnType<typeof policyScope>;

const scopeKeyOf = (base: PolicyScopeBase) =>
  base.scope === "organization" ? base.organizationId : base.workspaceId;

// Serialize per-scope publish/default mutations so concurrent callers can't
// double-create a generation or a second Default Rule. (A partial-unique index
// on the default is the durable guard — a follow-up hardening.) Exported so the
// callers can read + write under one lock.
export const lockScope = (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`policy:${base.scope}:${scopeKeyOf(base)}`}))`;

const toIdentityDto = (
  row: RuleRow["identities"][number],
): PolicyIdentityInput => {
  if (row.agentId) return { type: "agent", id: row.agentId };
  if (row.userId) return { type: "user", id: row.userId };
  if (row.groupId) return { type: "group", id: row.groupId };
  throw new Error("policy identity row names no principal");
};

const toTargetDto = (row: RuleRow["targets"][number]): PolicyTargetDto => {
  switch (row.kind) {
    case "app":
      if (!row.appProvider) throw new Error("app target missing provider");
      return {
        kind: "app",
        provider: row.appProvider,
        tools: row.appTools,
        connectionScope:
          row.appConnectionScope === "organization" ||
          row.appConnectionScope === "workspace"
            ? row.appConnectionScope
            : null,
      };
    case "connection":
      if (!row.appConnectionId) throw new Error("connection target missing id");
      return {
        kind: "connection",
        connectionId: row.appConnectionId,
        tools: row.appTools,
      };
    case "secret":
      // A secret target names EITHER a specific secret OR "all secrets at a level".
      if (
        row.secretScope === "organization" ||
        row.secretScope === "workspace"
      ) {
        return { kind: "secret", secretId: null, secretScope: row.secretScope };
      }
      if (!row.secretId) throw new Error("secret target missing id or scope");
      return { kind: "secret", secretId: row.secretId, secretScope: null };
    case "network":
      if (!row.hostPattern) throw new Error("network target missing host");
      return {
        kind: "network",
        hostPattern: row.hostPattern,
        pathPattern: row.pathPattern,
        method: row.method,
      };
    default:
      throw new Error(`unknown policy target kind: ${row.kind}`);
  }
};

const toRuleDto = (rule: RuleRow): PolicyRuleDto => ({
  id: rule.id,
  scope: rule.scope,
  status: rule.status,
  generation: rule.generation,
  priority: rule.priority,
  enabled: rule.enabled,
  isDefault: rule.isDefault,
  logicalId: rule.logicalId,
  source: rule.source,
  name: rule.name,
  description: rule.description,
  action: rule.action,
  rateLimit: rule.rateLimit,
  rateLimitWindow: rule.rateLimitWindow,
  requireApproval: rule.requireApproval,
  conditions: rule.conditions,
  identities: rule.identities.map(toIdentityDto),
  targets: rule.targets.map(toTargetDto),
  createdAt: rule.createdAt,
});

const identityCreate = (
  i: PolicyIdentityInput,
): Prisma.PolicyRuleIdentityCreateWithoutRuleInput => {
  switch (i.type) {
    case "agent":
      return { agent: { connect: { id: i.id } } };
    case "user":
      return { user: { connect: { id: i.id } } };
    case "group":
      return { group: { connect: { id: i.id } } };
  }
};

const targetCreate = (
  t: PolicyTargetInput,
): Prisma.PolicyRuleTargetCreateWithoutRuleInput => {
  switch (t.kind) {
    case "app":
      return {
        kind: "app",
        appProvider: t.provider,
        appTools: t.tools ?? [],
        appConnectionScope: t.connectionScope ?? null,
      };
    case "connection":
      // `appTools` narrow which endpoints the rule matches (empty = the
      // connection's whole app); the FK still injects the whole connection.
      return {
        kind: "connection",
        appConnection: { connect: { id: t.connectionId } },
        appTools: t.tools ?? [],
      };
    case "secret":
      // Specific secret → connect by id; "all secrets at a level" → the scope
      // marker (exactly one, guaranteed by `assertTargetsValid`).
      return t.secretId != null
        ? { kind: "secret", secret: { connect: { id: t.secretId } } }
        : { kind: "secret", secretScope: t.secretScope ?? null };
    case "network":
      return {
        kind: "network",
        hostPattern: t.hostPattern,
        pathPattern: t.pathPattern ?? null,
        method: t.method ?? null,
      };
  }
};

// Copy an existing identity/target row into a new rule (the publish snapshot).
const identityRowToCreate = (
  i: RuleRow["identities"][number],
): Prisma.PolicyRuleIdentityCreateWithoutRuleInput => {
  if (i.agentId) return { agent: { connect: { id: i.agentId } } };
  if (i.userId) return { user: { connect: { id: i.userId } } };
  if (i.groupId) return { group: { connect: { id: i.groupId } } };
  throw new Error("policy identity row names no principal");
};

const targetRowToCreate = (
  t: RuleRow["targets"][number],
): Prisma.PolicyRuleTargetCreateWithoutRuleInput => ({
  kind: t.kind,
  appProvider: t.appProvider,
  appTools: t.appTools,
  appConnectionScope: t.appConnectionScope,
  secretScope: t.secretScope,
  hostPattern: t.hostPattern,
  pathPattern: t.pathPattern,
  method: t.method,
  ...(t.appConnectionId
    ? { appConnection: { connect: { id: t.appConnectionId } } }
    : {}),
  ...(t.secretId ? { secret: { connect: { id: t.secretId } } } : {}),
});

// Drop redundant entries whose (rule, principal) / (rule, connection|secret)
// pair the DB would reject as a UNIQUE violation. Same-key entries are
// redundant, not an error (§2.6); app/network rows carry no such unique.
const dedupeIdentities = (
  items: PolicyIdentityInput[],
): PolicyIdentityInput[] => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.type}:${i.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const dedupeTargets = (items: PolicyTargetInput[]): PolicyTargetInput[] => {
  const seenConn = new Set<string>();
  const seenSecret = new Set<string>();
  return items.filter((t) => {
    if (t.kind === "connection") {
      if (seenConn.has(t.connectionId)) return false;
      seenConn.add(t.connectionId);
    } else if (t.kind === "secret" && t.secretId != null) {
      // Only specific-secret targets carry the (rule, secretId) unique; a
      // scope-based "all secrets" target has no id to dedupe.
      if (seenSecret.has(t.secretId)) return false;
      seenSecret.add(t.secretId);
    }
    return true;
  });
};

// True if any identity targets the directory (user / user-group) — the
// enterprise-gated "groups" capability. A plain agent / "any" rule is not.
const hasDirectoryIdentity = (
  identities: PolicyIdentityInput[] | undefined,
): boolean => (identities ?? []).some((i) => i.type !== "agent");

// True only for GROUP identities — the self-host license splits the directory
// arm: rules targeting individual users are free, group targeting is licensed.
// Cloud keeps gating both through "identity_directory" (its plan dial).
const hasGroupIdentity = (
  identities: PolicyIdentityInput[] | undefined,
): boolean => (identities ?? []).some((i) => i.type === "group");

// The paid-plan gate keys off the modifiers + directory identities, reusing the
// existing RuleActionGate (requireApproval → "manual_approval" [team], rateLimit
// → "rate_limit" [pro], a directory identity → "identity_directory" → "groups"
// [enterprise]; a group identity additionally → "identity_directory_group",
// the action the self-host entitlement gate keys on).
export const gatedActions = (rule: {
  rateLimit?: number | null;
  requireApproval?: boolean | null;
  hasDirectoryIdentity?: boolean;
  hasGroupIdentity?: boolean;
}): string[] => {
  const actions: string[] = [];
  if (rule.requireApproval) actions.push("manual_approval");
  if (rule.rateLimit != null) actions.push("rate_limit");
  if (rule.hasDirectoryIdentity) actions.push("identity_directory");
  if (rule.hasGroupIdentity) actions.push("identity_directory_group");
  return actions;
};

// `conditions` is opaque JSON already validated by Zod (or copied straight from
// the DB); this is the single unknown → InputJsonValue boundary cast.
const jsonInput = (
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull => {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
};

// A referenced identity/resource id that doesn't exist surfaces as P2025 from
// the nested `connect`; turn it into a clean 422 instead of a 500. (Scope
// validation of references lands with the resource picker in step 7.)
const asReferenceError = (err: unknown): never => {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2025"
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A referenced identity or resource does not exist.",
    );
  }
  throw err;
};

// Validate a rule's identities before write: (1) the LEVEL restriction — a
// WORKSPACE rule targets a specific agent or "any"; an ORG rule targets a user /
// user-group or "any"; and (2) OWNERSHIP — every referenced
// principal must belong to the acting org (agents to the acting workspace). The
// ownership check is a security invariant that closes the IDOR gap
// `asReferenceError` alone leaves open (it only proves existence, in any org).
// Reads the shared schema only (no `ee/` dependency), so it runs in every
// edition. "any" (empty identities) always passes.
export const assertIdentitiesValid = async (
  base: PolicyScopeBase,
  identities: PolicyIdentityInput[],
): Promise<void> => {
  const deduped = dedupeIdentities(identities);
  if (deduped.length === 0) return;

  const idsOf = (type: PolicyIdentityInput["type"]) =>
    deduped.filter((i) => i.type === type).map((i) => i.id);
  const agentIds = idsOf("agent");
  const userIds = idsOf("user");
  const groupIds = idsOf("group");

  // Level restriction. The onprem edition phrases it as the capability lock it
  // is there (directory identities are a OneCLI Cloud capability); the EE
  // editions keep the scope-shaped message byte-identical.
  if (base.scope === "workspace" && (userIds.length || groupIds.length)) {
    throw new ServiceError(
      "UNPROCESSABLE",
      isOnpremEdition()
        ? "Group and user identities are available on OneCLI Cloud."
        : "A workspace rule can target a specific agent or all agents.",
    );
  }
  if (base.scope === "organization" && agentIds.length) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "An organization rule targets users or user-groups, not a specific agent.",
    );
  }

  // Ownership — resolve the acting org (agents are additionally scoped to the
  // acting workspace).
  const organizationId =
    base.scope === "organization"
      ? base.organizationId
      : (
          await db.workspace.findUnique({
            where: { id: base.workspaceId },
            select: { organizationId: true },
          })
        )?.organizationId;
  if (!organizationId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Could not resolve the acting organization.",
    );
  }
  const workspaceId = base.scope === "workspace" ? base.workspaceId : null;

  const orgReferenceError = (): never => {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A referenced identity does not belong to this organization.",
    );
  };
  // Each kind is deduped, so an exact count match proves every id resolved.
  const verify = async (ids: string[], count: () => Promise<number>) => {
    if (ids.length === 0) return;
    if ((await count()) !== ids.length) orgReferenceError();
  };

  await Promise.all([
    verify(agentIds, () =>
      db.agent.count({
        where: {
          id: { in: agentIds },
          ...(workspaceId
            ? { workspaceId }
            : { workspace: { organizationId } }),
        },
      }),
    ),
    verify(userIds, () =>
      db.organizationMember.count({
        // Suspended members are non-members for every authz check (and the
        // gateway excludes them from the principal set), so a rule can't target
        // one — matches the connect-time active-member filter.
        where: {
          userId: { in: userIds },
          organizationId,
          status: { not: "suspended" },
        },
      }),
    ),
    verify(groupIds, () =>
      db.group.count({ where: { id: { in: groupIds }, organizationId } }),
    ),
  ]);
};

// Validate a rule's connection/secret TARGET references before write: every
// referenced connection / secret must belong to the acting org — a WORKSPACE rule
// may name its own workspace's resources or org-level ones (mirrors the equipment
// reference check in `agent-service`); an ORG rule may name org-level resources
// only. This is the same OWNERSHIP invariant `assertIdentitiesValid` enforces for
// identities, and it closes the IDOR gap `asReferenceError` leaves open (it only
// proves existence, in ANY org). `app`/`network` targets carry no owned id, so
// they're skipped; "no connection/secret targets" always passes. Reads the shared
// schema only (no `ee/` dependency), so it runs in every edition.
export const assertTargetsValid = async (
  base: PolicyScopeBase,
  targets: PolicyTargetInput[],
): Promise<void> => {
  // A secret target names EITHER a specific `secretId` OR a `secretScope` — the
  // XOR the kind_shape CHECK enforces. Validate here so a malformed target is a
  // clean 422, not a DB constraint 500 (mirrors the `app` shape).
  if (
    targets.some(
      (t) =>
        t.kind === "secret" && (t.secretId == null) === (t.secretScope == null),
    )
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A secret target must name either a specific secret or a level, not both.",
    );
  }

  // Level restriction for an "all resources at a level" target (step 8): a
  // WORKSPACE rule can only scope to its OWN workspace — it can't reach org-level
  // connections/secrets. An ORG rule may scope to `organization` OR `workspace`
  // (the level-spanning guardrail that lets each agent use its own resources).
  if (
    base.scope === "workspace" &&
    targets.some(
      (t) =>
        (t.kind === "app" && t.connectionScope === "organization") ||
        (t.kind === "secret" && t.secretScope === "organization"),
    )
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A workspace rule's target can't scope to organization-level resources.",
    );
  }

  const connectionIds = [
    ...new Set(
      targets.flatMap((t) => (t.kind === "connection" ? [t.connectionId] : [])),
    ),
  ];
  // Only specific-secret targets carry an owned id to fence; a scope-based "all
  // secrets" target is a level marker (guarded above), not a reference.
  const secretIds = [
    ...new Set(
      targets.flatMap((t) =>
        t.kind === "secret" && t.secretId != null ? [t.secretId] : [],
      ),
    ),
  ];
  if (connectionIds.length === 0 && secretIds.length === 0) return;

  // Resolve the acting org (a workspace rule's resources are additionally scoped to
  // its own workspace; an org rule's to org-level resources) — same as the identity
  // ownership check.
  const organizationId =
    base.scope === "organization"
      ? base.organizationId
      : (
          await db.workspace.findUnique({
            where: { id: base.workspaceId },
            select: { organizationId: true },
          })
        )?.organizationId;
  if (!organizationId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Could not resolve the acting organization.",
    );
  }
  const workspaceId = base.scope === "workspace" ? base.workspaceId : null;

  // The resources this rule may reference: a WORKSPACE rule may name ONLY its own
  // workspace's resources — org-level connections/secrets are governed at the org
  // level (an org rule grants them; a workspace rule can't reach up to reference
  // one). An ORG rule names org-level resources. Fences on the acting org either
  // way — a foreign id is simply absent from the count.
  const ownerScope = workspaceId
    ? { workspaceId }
    : { organizationId, scope: "organization" as const };

  const targetReferenceError = (): never => {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A referenced connection or secret does not belong to this organization.",
    );
  };
  // Each set is deduped, so an exact count match proves every id resolved.
  const verify = async (ids: string[], count: () => Promise<number>) => {
    if (ids.length === 0) return;
    if ((await count()) !== ids.length) targetReferenceError();
  };

  await Promise.all([
    verify(connectionIds, () =>
      db.appConnection.count({
        where: { id: { in: connectionIds }, ...ownerScope },
      }),
    ),
    verify(secretIds, () =>
      db.secret.count({ where: { id: { in: secretIds }, ...ownerScope } }),
    ),
  ]);
};

/**
 * Validate a rule's granular session policy (object `conditions` — repos/folders
 * scoping a connection's injected credential). Enforces the two invariants the
 * dialog encodes — it applies only to an ALLOW (a Block injects nothing) and only
 * with a connection target — then runs the wired policy validator per
 * connection target. EE deep-checks the shape against the provider (repos
 * exist on the installation, absolute Dropbox paths) and gates the team+
 * entitlement; OSS wires a validator that REJECTS session policies outright
 * (granular scoping is a OneCLI Cloud capability — step 9.5). A no-op for
 * behavioral / absent conditions. Same org fence as `assertTargetsValid`.
 *
 * Callers pass the MERGED (post-update) action/targets/conditions, so no PATCH
 * ordering can pair an object policy with a connection while skipping these gates.
 */
export const assertSessionPolicyValid = async (
  base: PolicyScopeBase,
  targets: PolicyTargetInput[] | undefined,
  conditions: unknown,
  action: "allow" | "block",
): Promise<void> => {
  if (!isSessionPolicy(conditions)) return;
  if (action !== "allow") {
    // A session policy scopes an INJECTED credential; a Block injects nothing, so
    // the scope would be silently inert. Reject it (mirrors `modifiersRequireAllow`
    // and the dialog, which offers Resources only on an Allow).
    throw new ServiceError(
      "UNPROCESSABLE",
      "resource scoping (repositories/folders) applies only to Allow rules",
    );
  }
  const connectionIds = [
    ...new Set(
      (targets ?? []).flatMap((t) =>
        t.kind === "connection" ? [t.connectionId] : [],
      ),
    ),
  ];
  if (connectionIds.length === 0) {
    // A session policy scopes a connection's injected credential — illegal (and
    // unentitled) without a connection target. On CREATE the Zod refine catches
    // this; on UPDATE there is no refine, so enforce it here against the MERGED
    // rule state. Without this throw, a later "add a connection target" PATCH
    // could pair a stored object policy with a connection while never running
    // the team-tier entitlement gate below (which lives only in the loop).
    throw new ServiceError(
      "UNPROCESSABLE",
      "resource scoping (repositories/folders) requires a connection target",
    );
  }
  const organizationId =
    base.scope === "organization"
      ? base.organizationId
      : (
          await db.workspace.findUnique({
            where: { id: base.workspaceId },
            select: { organizationId: true },
          })
        )?.organizationId;
  if (!organizationId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Could not resolve the acting organization.",
    );
  }
  const ownerScope =
    base.scope === "workspace"
      ? { workspaceId: base.workspaceId }
      : { organizationId, scope: "organization" as const };
  const conns = await db.appConnection.findMany({
    where: { id: { in: connectionIds }, ...ownerScope },
    select: { provider: true, metadata: true },
  });
  const validator = getPolicyValidator();
  for (const c of conns) {
    await validator.validate(
      organizationId,
      c.provider,
      c.metadata as Record<string, unknown> | null,
      conditions as Record<string, unknown>,
    );
  }
};

export const listPolicyRules = async (
  scope: ResourceScope,
  status: PolicyStatus,
): Promise<PolicyRuleDto[]> => {
  const base = policyScope(scope);
  const where: Prisma.PolicyRuleV2WhereInput = {
    ...base,
    status,
    isDefault: false,
  };
  // Published rows accumulate per generation; return only the active one.
  if (status === "published") {
    const agg = await db.policyRuleV2.aggregate({
      where: { ...base, status: "published" },
      _max: { generation: true },
    });
    if (agg._max.generation === null) return [];
    where.generation = agg._max.generation;
  }
  const rules = await db.policyRuleV2.findMany({
    where,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    include: RULE_INCLUDE,
  });
  return rules.map(toRuleDto);
};

export const getPolicyRule = async (
  scope: ResourceScope,
  id: string,
): Promise<PolicyRuleDto> => {
  const rule = await db.policyRuleV2.findFirst({
    where: { id, ...policyScope(scope), status: "draft", isDefault: false },
    include: RULE_INCLUDE,
  });
  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found.");
  return toRuleDto(rule);
};

export const createPolicyRule = async (
  scope: ResourceScope,
  input: CreatePolicyRuleInput,
  userId: string,
): Promise<PolicyRuleDto> => {
  const base = policyScope(scope);
  await assertIdentitiesValid(base, input.identities ?? []);
  // A rule must name at least one target — an empty target list matches NOTHING at
  // the gateway (fail-closed), never "any", so it is never a valid authored rule.
  // `createPolicyRule` only ever makes non-default custom rules (isDefault:false
  // below), so this is unconditional; the terminal Default Rule is target-less by
  // construction and created via `setDefault`, not here.
  if (!input.targets || input.targets.length === 0) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A rule must name at least one target.",
    );
  }
  await assertTargetsValid(base, input.targets);
  await getPolicyValidator().validateTargets?.(input.targets);
  await assertSessionPolicyValid(
    base,
    input.targets,
    input.conditions,
    input.action,
  );
  await getRuleActionGate().assertAllowed(
    scope,
    gatedActions({
      rateLimit: input.rateLimit,
      requireApproval: input.requireApproval,
      hasDirectoryIdentity: hasDirectoryIdentity(input.identities),
      hasGroupIdentity: hasGroupIdentity(input.identities),
    }),
  );
  try {
    // The max-read + insert run under the per-scope advisory lock every other
    // priority writer takes, so concurrent appends can't mint DUPLICATE
    // priorities (tied priorities make first-match order nondeterministic).
    const rule = await db.$transaction(async (tx) => {
      await lockScope(tx, base);
      const agg = await tx.policyRuleV2.aggregate({
        where: { ...base, status: "draft", isDefault: false },
        _max: { priority: true },
      });
      const created = await tx.policyRuleV2.create({
        data: {
          ...base,
          status: "draft",
          generation: 0,
          priority: (agg._max.priority ?? 0) + 1,
          isDefault: false,
          enabled: input.enabled ?? true,
          name: input.name,
          description: input.description ?? null,
          action: input.action,
          rateLimit: input.rateLimit ?? null,
          rateLimitWindow: input.rateLimitWindow ?? null,
          requireApproval: input.requireApproval ?? false,
          conditions: jsonInput(input.conditions),
          createdByUserId: userId,
          identities: {
            create: dedupeIdentities(input.identities ?? []).map(
              identityCreate,
            ),
          },
          targets: {
            create: dedupeTargets(input.targets ?? []).map(targetCreate),
          },
        },
        include: RULE_INCLUDE,
      });
      await publishDraftInTx(tx, base, userId);
      return created;
    });
    // Manual ordering: a new rule APPENDS (max+1 priority above) and stays
    // where the user can see it; order changes only via explicit reorder.
    return toRuleDto(rule);
  } catch (err) {
    return asReferenceError(err);
  }
};

export const updatePolicyRule = async (
  scope: ResourceScope,
  id: string,
  input: UpdatePolicyRuleInput,
  userId: string,
): Promise<PolicyRuleDto> => {
  const base = policyScope(scope);
  const existing = await db.policyRuleV2.findFirst({
    where: { id, ...base, status: "draft", isDefault: false },
    include: { targets: true },
  });
  if (!existing) throw new ServiceError("NOT_FOUND", "Policy rule not found.");

  const nextAction = input.action ?? existing.action;
  const nextRateLimit =
    input.rateLimit !== undefined ? input.rateLimit : existing.rateLimit;
  const nextWindow =
    input.rateLimitWindow !== undefined
      ? input.rateLimitWindow
      : existing.rateLimitWindow;
  const nextApproval =
    input.requireApproval !== undefined
      ? input.requireApproval
      : existing.requireApproval;

  if (
    nextAction === "block" &&
    (nextRateLimit != null || nextWindow != null || nextApproval)
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "rate-limit and approval modifiers require action = allow",
    );
  }
  if ((nextRateLimit == null) !== (nextWindow == null)) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "rateLimit and rateLimitWindow must be provided together",
    );
  }
  // Validate identities (level + ownership) only when they're being changed.
  if (input.identities !== undefined) {
    await assertIdentitiesValid(base, input.identities);
  }
  // Validate connection/secret target references (ownership) only when targets
  // are being changed. A provided target list must be non-empty — clearing a
  // rule's targets to [] would leave it matching NOTHING at the gateway
  // (fail-closed); the editor preserves a rule by OMITTING targets, never by
  // sending []. (`existing` is fenced to isDefault:false above, so this never hits
  // the target-less Default Rule.)
  if (input.targets !== undefined) {
    if (input.targets.length === 0) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "A rule must name at least one target.",
      );
    }
    await assertTargetsValid(base, input.targets);
    await getPolicyValidator().validateTargets?.(input.targets);
  }
  // A granular session policy (object conditions) is validated against the rule's
  // MERGED state — re-checked whenever conditions, targets, OR action change, so a
  // connection target (or a flip to Allow) added in a LATER PATCH can't pair with a
  // stored object policy while skipping the allow/connection/entitlement gates.
  if (
    input.conditions !== undefined ||
    input.targets !== undefined ||
    input.action !== undefined
  ) {
    const mergedConditions =
      input.conditions !== undefined ? input.conditions : existing.conditions;
    const mergedTargets =
      input.targets ??
      existing.targets
        .filter((t) => t.kind === "connection" && t.appConnectionId != null)
        .map((t) => ({
          kind: "connection" as const,
          connectionId: t.appConnectionId as string,
        }));
    await assertSessionPolicyValid(
      base,
      mergedTargets,
      mergedConditions,
      input.action ?? (existing.action as "allow" | "block"),
    );
  }
  // Gate only the paid modifiers / directory identities this update actually
  // enables — a name-only edit of a grandfathered rule shouldn't re-check the plan.
  await getRuleActionGate().assertAllowed(
    scope,
    gatedActions({
      rateLimit: input.rateLimit,
      requireApproval: input.requireApproval,
      hasDirectoryIdentity: hasDirectoryIdentity(input.identities),
      hasGroupIdentity: hasGroupIdentity(input.identities),
    }),
  );

  try {
    const rule = await db.$transaction(async (tx) => {
      await lockScope(tx, base);
      if (input.identities !== undefined) {
        await tx.policyRuleIdentity.deleteMany({ where: { ruleId: id } });
      }
      if (input.targets !== undefined) {
        await tx.policyRuleTarget.deleteMany({ where: { ruleId: id } });
      }
      const updated = await tx.policyRuleV2.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.rateLimit !== undefined
            ? { rateLimit: input.rateLimit }
            : {}),
          ...(input.rateLimitWindow !== undefined
            ? { rateLimitWindow: input.rateLimitWindow }
            : {}),
          ...(input.requireApproval !== undefined
            ? { requireApproval: input.requireApproval }
            : {}),
          ...(input.conditions !== undefined
            ? { conditions: jsonInput(input.conditions) }
            : {}),
          ...(input.identities !== undefined
            ? {
                identities: {
                  create: dedupeIdentities(input.identities).map(
                    identityCreate,
                  ),
                },
              }
            : {}),
          ...(input.targets !== undefined
            ? {
                targets: {
                  create: dedupeTargets(input.targets).map(targetCreate),
                },
              }
            : {}),
        },
        include: RULE_INCLUDE,
      });
      await publishDraftInTx(tx, base, userId);
      return updated;
    });
    // Manual ordering: an edit NEVER moves the rule (priority is not written
    // here) — the position the user chose is part of the policy.
    return toRuleDto(rule);
  } catch (err) {
    return asReferenceError(err);
  }
};

export const deletePolicyRule = async (
  scope: ResourceScope,
  id: string,
  userId: string,
): Promise<void> => {
  const base = policyScope(scope);
  await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    // The scope fence and the existence check are the delete itself, under the
    // lock: a rule gone between a pre-check and the delete would otherwise
    // surface as P2025 (a 500) instead of a 404, and a foreign id must never
    // match. Zero rows = not found, nothing published.
    const { count } = await tx.policyRuleV2.deleteMany({
      where: { id, ...base, status: "draft", isDefault: false },
    });
    if (count === 0) {
      throw new ServiceError("NOT_FOUND", "Policy rule not found.");
    }
    await publishDraftInTx(tx, base, userId);
  });
  // Manual ordering: deleting leaves a priority gap — harmless (only relative
  // order matters to first-match; the UI numbers rows by index) and renumbered
  // densely by the next explicit reorder.
};

export const reorderPolicyRules = async (
  scope: ResourceScope,
  orderedIds: string[],
  userId: string,
): Promise<PolicyRuleDto[]> => {
  const base = policyScope(scope);
  try {
    await db.$transaction(async (tx) => {
      // Validate + write under the per-scope advisory lock, so a reorder can't
      // interleave with a concurrent write rewriting the same draft.
      await lockScope(tx, base);
      const draft = await tx.policyRuleV2.findMany({
        where: { ...base, status: "draft", isDefault: false },
        select: { id: true },
      });
      const draftIds = new Set(draft.map((r) => r.id));
      const uniqueOrdered = new Set(orderedIds);
      const namesEveryRuleOnce =
        orderedIds.length === draftIds.size &&
        uniqueOrdered.size === orderedIds.length &&
        orderedIds.every((id) => draftIds.has(id));
      if (!namesEveryRuleOnce) {
        throw new ServiceError(
          "CONFLICT",
          "Rule set changed. Refresh and try again.",
        );
      }
      // Ascending: index 0 → priority 1 (lowest = evaluated first / wins).
      for (const [i, id] of orderedIds.entries()) {
        await tx.policyRuleV2.update({
          where: { id },
          data: { priority: i + 1 },
        });
      }
      await publishDraftInTx(tx, base, userId);
    });
  } catch (err) {
    // Every rule writer holds the scope lock, so the in-tx read is current; a
    // row that still vanishes before its update (the scope itself being
    // deleted cascades without the lock) surfaces as P2025 — same staleness,
    // same 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "Rule set changed. Refresh and try again.",
      );
    }
    throw err;
  }
  return listPolicyRules(scope, "draft");
};

// The terminal Default Rule is a per-scope singleton (isDefault). Both scopes
// now default to ALLOW (the attach-model posture — deny-by-default is the
// admin's opt-in flip on the org Default Rule): this covers lazy creation
// (ensureDefault on publish/PATCH) and the virtual default, so an org whose
// birth seed failed can never resurrect a Block nobody chose. The parameter
// stays so every call site keeps naming its scope base.
const defaultAction: (base: PolicyScopeBase) => "allow" | "block" = () =>
  "allow";

const findDefault = async (
  client: Prisma.TransactionClient | typeof db,
  base: PolicyScopeBase,
  status: PolicyStatus = "draft",
) => {
  const where: Prisma.PolicyRuleV2WhereInput = {
    ...base,
    status,
    isDefault: true,
  };
  // Published rows accumulate one default per generation; pin the active one
  // (max generation), mirroring listPolicyRules — else drift compares a stale gen.
  if (status === "published") {
    const agg = await client.policyRuleV2.aggregate({
      where: { ...base, status: "published" },
      _max: { generation: true },
    });
    if (agg._max.generation === null) return null;
    where.generation = agg._max.generation;
  }
  return client.policyRuleV2.findFirst({ where, include: RULE_INCLUDE });
};

// Create the default if absent — callers hold the per-scope lock (writes only).
const ensureDefault = async (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
): Promise<RuleRow> => {
  const existing = await findDefault(tx, base);
  if (existing) return existing;
  return tx.policyRuleV2.create({
    data: {
      ...base,
      status: "draft",
      generation: 0,
      priority: 0,
      isDefault: true,
      enabled: true,
      source: "default",
      name: "Default Rule",
      action: defaultAction(base),
      requireApproval: false,
    },
    include: RULE_INCLUDE,
  });
};

// A computed default returned by GET when none is persisted (id "" = virtual),
// so reads never mutate. Persisted on the first PATCH /default or publish.
const virtualDefault = (base: PolicyScopeBase): PolicyRuleDto => ({
  id: "",
  logicalId: "",
  scope: base.scope,
  status: "draft",
  generation: 0,
  priority: 0,
  enabled: true,
  isDefault: true,
  source: "default",
  name: "Default Rule",
  description: null,
  action: defaultAction(base),
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [],
  createdAt: new Date(0),
});

export const getPolicyDefault = async (
  scope: ResourceScope,
  status: PolicyStatus = "draft",
): Promise<PolicyRuleDto> => {
  const base = policyScope(scope);
  const existing = await findDefault(db, base, status);
  return existing ? toRuleDto(existing) : virtualDefault(base);
};

export const setPolicyDefaultAction = async (
  scope: ResourceScope,
  action: "allow" | "block",
  userId: string,
): Promise<PolicyRuleDto> => {
  const base = policyScope(scope);
  const updated = await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    const def = await ensureDefault(tx, base);
    const row = await tx.policyRuleV2.update({
      where: { id: def.id },
      data: { action },
      include: RULE_INCLUDE,
    });
    await publishDraftInTx(tx, base, userId);
    return row;
  });
  return toRuleDto(updated);
};

/**
 * A principal about to be deleted, with the policy scope its rules live in.
 * Agents only appear in their workspace's rules and groups only in their
 * organization's (`assertIdentitiesValid`); a user can be named in the rules
 * of every organization they ever belonged to, so a user carries no scope.
 */
export type DeletedPrincipal =
  | { kind: "agent"; id: string; workspaceId: string }
  | { kind: "group"; id: string; organizationId: string }
  | { kind: "user"; id: string };

/**
 * Forget a principal in the policy rules, in the draft and in every retained
 * published generation alike. Runs INSIDE the caller's transaction, BEFORE the
 * principal's row goes.
 *
 * Why it must: the identity's `agent_id` / `user_id` / `group_id` cascades,
 * and a rule left with NO identity does not vanish. In the block/allow engine
 * an empty identity means "everyone", so a rule that named only this
 * principal would silently start applying to everyone: a grant's "everything
 * else: block" blocking its siblings, an org "only this group may reach X"
 * allow opening X past a deny default, a "block this user" blocking all users.
 * So a rule whose ONLY identity is this principal goes with it (its targets
 * and conditions cascade), whatever its source; a rule naming other principals
 * too just loses this one by the cascade, which is exactly right.
 *
 * Applied to the live generation in place rather than by republishing: this
 * is a system cleanup riding the principal's own delete, not a policy edit,
 * so it mints no generation (and no publish provenance) of its own. Retained
 * generations are rollback targets, so they are cleaned too (rolling back to
 * one would otherwise resurrect the rule identity-less).
 *
 * Locking: what closes the race is the principal's ROW lock. Inserting an
 * identity takes a share lock on the row it references (the FK check), so
 * once the delete holds `FOR UPDATE` on that row, no new identity naming the
 * principal can commit before the row is gone; it waits, then fails the FK.
 * An identity written before the lock was taken is visible to the delete
 * below. The scope locks (taken first, sorted) order this against the writers
 * that take them, so they never deadlock with it. An agent's caller holds
 * the workspace scope lock and then the agent's row lock (see `deleteAgent`);
 * a group's arm and a user's arm take theirs here.
 *
 * Returns the organizations whose rules changed, so the caller can flush
 * their gateway caches after the commit. An agent's caller flushes its
 * workspace (as for every agent delete), so its arm returns none.
 */
export const dropPrincipalFromPolicyInTx = async (
  tx: Prisma.TransactionClient,
  principal: DeletedPrincipal,
): Promise<string[]> => {
  switch (principal.kind) {
    case "agent": {
      const agentId = principal.id;
      await tx.policyRuleV2.deleteMany({
        where: {
          scope: "workspace",
          workspaceId: principal.workspaceId,
          OR: [
            { identities: { some: { agentId }, every: { agentId } } },
            // A GRANT is one agent's rule by construction, so one with no
            // identity is always an orphan. The migration that removed the
            // old ones runs before the rollout, so a delete by the previous
            // release in that window can still leave one; sweep it on the
            // next delete.
            { source: GRANT_SOURCE, identities: { none: {} } },
          ],
        },
      });
      return [];
    }
    case "group": {
      const { organizationId, id: groupId } = principal;
      await lockScope(tx, { scope: "organization", organizationId });
      await tx.$queryRaw`SELECT id FROM groups WHERE id = ${groupId} FOR UPDATE`;
      const { count } = await tx.policyRuleV2.deleteMany({
        where: {
          scope: "organization",
          organizationId,
          identities: { some: { groupId }, every: { groupId } },
        },
      });
      return count > 0 ? [organizationId] : [];
    }
    case "user": {
      const userId = principal.id;
      const where: Prisma.PolicyRuleV2WhereInput = {
        scope: "organization",
        identities: { some: { userId }, every: { userId } },
      };
      const organizationsOf = async () =>
        (
          await tx.policyRuleV2.findMany({
            where,
            select: { organizationId: true },
            distinct: ["organizationId"],
          })
        )
          .flatMap((r) => (r.organizationId ? [r.organizationId] : []))
          .sort();
      for (const organizationId of await organizationsOf()) {
        await lockScope(tx, { scope: "organization", organizationId });
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      // Re-read under the row lock: the set the delete below actually covers.
      const organizationIds = await organizationsOf();
      await tx.policyRuleV2.deleteMany({ where });
      return organizationIds;
    }
  }
};

export interface PublishResult {
  generation: number;
  ruleCount: number;
}

// How many published generations to retain per scope for rollback; older ones
// are pruned on publish. Every write publishes, so this window is what keeps
// the table bounded under steady editing.
const PUBLISHED_GENERATION_RETENTION = 10;

// Gate-less snapshot of the given draft rows into a fresh published generation
// (active published set = max(generation)). Callers hold the scope lock and have
// already read `draftRules`.
const snapshotDraftRules = async (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
  draftRules: RuleRow[],
  userId: string | null,
): Promise<PublishResult> => {
  const maxGen = await tx.policyRuleV2.aggregate({
    where: { ...base, status: "published" },
    _max: { generation: true },
  });
  const generation = (maxGen._max.generation ?? 0) + 1;
  for (const r of draftRules) {
    await tx.policyRuleV2.create({
      data: {
        ...base,
        status: "published",
        generation,
        priority: r.priority,
        isDefault: r.isDefault,
        source: r.source,
        // Stable across generations — the rate counter keys on it.
        logicalId: r.logicalId,
        enabled: r.enabled,
        name: r.name,
        description: r.description,
        action: r.action,
        rateLimit: r.rateLimit,
        rateLimitWindow: r.rateLimitWindow,
        requireApproval: r.requireApproval,
        conditions: jsonInput(r.conditions),
        createdByUserId: userId,
        identities: { create: r.identities.map(identityRowToCreate) },
        targets: { create: r.targets.map(targetRowToCreate) },
      },
    });
  }
  // Prune published generations beyond the rollback retention window so the
  // per-write publish can't grow the table unbounded. The gateway reads only
  // max(generation); older ones exist only for rollback.
  if (generation > PUBLISHED_GENERATION_RETENTION) {
    await tx.policyRuleV2.deleteMany({
      where: {
        ...base,
        status: "published",
        generation: { lte: generation - PUBLISHED_GENERATION_RETENTION },
      },
    });
  }
  return { generation, ruleCount: draftRules.length };
};

/**
 * Publish the scope's whole draft as a fresh generation, inside the caller's
 * transaction. Callers hold the scope lock. Every policy write (and every
 * grant write) ends here, so the draft and the live generation never drift:
 * there is nothing staged to review. Gate-less on purpose: each write already
 * gated exactly what it changed, and re-gating the whole draft would block a
 * downgraded org from even deleting a grandfathered rule.
 */
export const publishDraftInTx = async (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
  userId: string | null,
): Promise<PublishResult> => {
  await ensureDefault(tx, base);
  // The draft publishes exactly as the user arranged it: the priorities ARE
  // the policy (top-down first-match).
  const draftRules = await tx.policyRuleV2.findMany({
    where: { ...base, status: "draft" },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  return snapshotDraftRules(tx, base, draftRules, userId);
};

/** Republish the draft on demand. Writes already publish, so this is only a
 * compatibility endpoint for older CLIs (`onecli org policy publish`). */
export const publishPolicy = async (
  scope: ResourceScope,
  userId: string,
): Promise<PublishResult> => {
  const base = policyScope(scope);
  return db.$transaction(async (tx) => {
    await lockScope(tx, base);
    return publishDraftInTx(tx, base, userId);
  });
};

// ── Step-5 cutover backfill ──────────────────────────────────────────────────

/** A target to materialize. Unlike `PolicyTargetInput` (the API's strict method
 * enum), `method` is the verbatim old-column free string the translator carries,
 * so a legacy row's method is preserved exactly (the DB column is a free string
 * too). Structurally the translator's `NewTarget` for network/app/connection; the
 * `secret` arm keeps the stored `secretId` (the evaluator's `NewTarget` secret arm
 * instead carries the gateway-resolved host patterns). */
export type BackfillTargetInput =
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    }
  | {
      kind: "app";
      provider: string;
      tools: string[];
      connectionScope: "organization" | "workspace" | null;
    }
  | { kind: "connection"; connectionId: string; tools: string[] }
  | { kind: "secret"; secretId: string };

/** One translated rule to materialize (the translator's `NewRule`, structurally
 * — agent identities + network/app/connection/secret targets). */
export interface BackfillRuleInput {
  priority: number;
  isDefault: boolean;
  /** Rule origin — the DERIVED sources
   * (app_permission / blocklist / equipment); custom/default are kept. */
  source: "custom" | "app_permission" | "blocklist" | "default" | "equipment";
  name: string;
  action: "allow" | "block";
  rateLimit: number | null;
  rateLimitWindow: "minute" | "hour" | "day" | null;
  requireApproval: boolean;
  conditions: unknown;
  identities: PolicyIdentityInput[];
  targets: BackfillTargetInput[];
  /** Omitted = true. The OSS cutover (step 9.5) carries disabled legacy rows
   * with `false` so user data survives into the editor; decision-neutral (the
   * gateway loads `enabled = true` only). */
  enabled?: boolean;
  /** Omitted = null. The OSS cutover stamps its migrated Default Rules so a
   * user publish that pre-empted migration is detectable (decision-neutral). */
  description?: string | null;
}

// Method stays a verbatim string (not the API enum) — see BackfillTargetInput.
// connection/secret (step 8) connect by id, mirroring `targetCreate`.
const backfillTargetCreate = (
  t: BackfillTargetInput,
): Prisma.PolicyRuleTargetCreateWithoutRuleInput => {
  switch (t.kind) {
    case "app":
      return {
        kind: "app",
        appProvider: t.provider,
        appTools: t.tools,
        appConnectionScope: t.connectionScope,
      };
    case "network":
      return {
        kind: "network",
        hostPattern: t.hostPattern,
        pathPattern: t.pathPattern,
        method: t.method,
      };
    case "connection":
      return {
        kind: "connection",
        appConnection: { connect: { id: t.connectionId } },
        appTools: t.tools,
      };
    case "secret":
      return { kind: "secret", secret: { connect: { id: t.secretId } } };
  }
};

export interface BackfillResult {
  skipped: boolean;
  generation: number | null;
  ruleCount: number;
}

/**
 * Materialize a scope's translated rules as the draft working copy + published
 * generation 1 (the gateway reads published). **Idempotent** — skips a scope that
 * already has a published generation, so it's safe to re-run. **Gate-less**: it
 * materializes EXISTING, already-entitled policy (not a new user edit), so it
 * bypasses the `RuleActionGate`. Not for user writes — those go through
 * create/update/publish. Callers preserve the translator's `priority` order.
 */
export const backfillPublishScope = async (
  scope: ResourceScope,
  rules: BackfillRuleInput[],
): Promise<BackfillResult> => {
  const base = policyScope(scope);
  return db.$transaction(
    async (tx) => {
      await lockScope(tx, base);
      const published = await tx.policyRuleV2.count({
        where: { ...base, status: "published" },
      });
      if (published > 0) {
        return { skipped: true, generation: null, ruleCount: 0 };
      }
      for (const r of rules) {
        const common = {
          ...base,
          priority: r.priority,
          isDefault: r.isDefault,
          source: r.source,
          enabled: r.enabled ?? true,
          description: r.description ?? null,
          name: r.name,
          action: r.action,
          rateLimit: r.rateLimit ?? null,
          rateLimitWindow: r.rateLimitWindow ?? null,
          requireApproval: r.requireApproval,
          conditions: jsonInput(r.conditions),
        };
        // Draft working copy (gen 0) + the published snapshot (gen 1) the gateway
        // reads — identical at cutover. Fresh nested-create per row. The published
        // row copies the draft's logicalId so the rate counter stays stable across
        // future republishes.
        const draft = await tx.policyRuleV2.create({
          data: {
            ...common,
            status: "draft",
            generation: 0,
            identities: { create: r.identities.map(identityCreate) },
            targets: { create: r.targets.map(backfillTargetCreate) },
          },
          select: { logicalId: true },
        });
        await tx.policyRuleV2.create({
          data: {
            ...common,
            status: "published",
            generation: 1,
            logicalId: draft.logicalId,
            identities: { create: r.identities.map(identityCreate) },
            targets: { create: r.targets.map(backfillTargetCreate) },
          },
        });
      }
      // An empty scope (e.g. a ruleless workspace — the common case) publishes
      // nothing; report generation null so the verifier treats it as vacuously OK
      // rather than "not backfilled".
      return {
        skipped: false,
        generation: rules.length > 0 ? 1 : null,
        ruleCount: rules.length,
      };
      // A large scope (hundreds of per-tool legacy rows → 2 sequential creates
      // each) can exceed Prisma's default 5s interactive-tx timeout — which
      // would fail the SAME way every boot and strand the scope on legacy
      // permanently. Generous ceiling; the per-scope advisory lock already
      // serializes writers.
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
};

export interface LastPublishDto {
  generation: number;
  ruleCount: number;
  appliedAt: Date;
  /** Who made the write that minted the live generation — null for a system
   * publish (the new-scope seeder) or a pre-provenance generation. */
  appliedBy: { name: string | null; email: string } | null;
}

/** The scope's most recent publish — who made the last write and when. Null =
 * never published. Served to older CLIs (`onecli org policy status`). A
 * zero-schema read: the newest generation's rows already carry the author
 * (`createdByUserId` → the `createdByUser` relation) and the publish instant
 * (`createdAt`). */
export const getLastPublish = async (
  scope: ResourceScope,
): Promise<LastPublishDto | null> => {
  const base = policyScope(scope);
  const newest = await db.policyRuleV2.findFirst({
    where: { ...base, status: "published" },
    orderBy: { generation: "desc" },
    select: {
      generation: true,
      createdAt: true,
      createdByUser: { select: { name: true, email: true } },
    },
  });
  if (!newest) return null;
  const ruleCount = await db.policyRuleV2.count({
    where: { ...base, status: "published", generation: newest.generation },
  });
  return {
    generation: newest.generation,
    ruleCount,
    appliedAt: newest.createdAt,
    appliedBy: newest.createdByUser
      ? { name: newest.createdByUser.name, email: newest.createdByUser.email }
      : null,
  };
};
