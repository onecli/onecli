import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import { bridgeDerivedSources, isOssEdition } from "../lib/policy-flags";
import { type ResourceScope } from "./resource-scope";
import { getPolicyValidator, getRuleActionGate } from "../providers";
import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
  PolicyIdentityInput,
  PolicyTargetInput,
} from "../validations/policy";
import { isSessionPolicy } from "../validations/policy";

// ── Unified policy engine service (policy_rules_v2) ─────────────────────────
// CRUD + reorder + publish over the priority-ordered, first-match rule model.
// Each scope has a draft (editable) set and published (active) snapshots; the
// gateway will read only the active published generation — this service is
// otherwise inert in step 2.

type PolicyStatus = "draft" | "published";

const RULE_INCLUDE = {
  identities: true,
  targets: true,
} satisfies Prisma.PolicyRuleV2Include;

type RuleRow = Prisma.PolicyRuleV2GetPayload<{ include: typeof RULE_INCLUDE }>;

/** A full policy rule row (identities + targets included) — the currency of the
 * publish/generation machinery, exported for the coherence bridge. */
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
      connectionScope: "organization" | "project" | null;
    }
  | { kind: "connection"; connectionId: string; tools: string[] }
  | {
      kind: "secret";
      secretId: string | null;
      secretScope: "organization" | "project" | null;
    }
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    };

// A rule is scoped to exactly one of org/project (mirrors the scope_shape CHECK);
// the routes always pass exactly one, so partner scope never reaches here.
export const policyScope = (scope: ResourceScope) => {
  if (scope.organizationId) {
    return {
      scope: "organization" as const,
      organizationId: scope.organizationId,
    };
  }
  if (scope.projectId) {
    return { scope: "project" as const, projectId: scope.projectId };
  }
  throw new ServiceError(
    "BAD_REQUEST",
    "A policy scope requires a project or organization.",
  );
};

export type PolicyScopeBase = ReturnType<typeof policyScope>;

const scopeKeyOf = (base: PolicyScopeBase) =>
  base.scope === "organization" ? base.organizationId : base.projectId;

// Serialize per-scope publish/default mutations so concurrent callers can't
// double-create a generation or a second Default Rule. (A partial-unique index
// on the default is the durable guard — a follow-up hardening.) Exported so the
// coherence bridge can read + write under one lock.
export const lockScope = (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`policy:${base.scope}:${scopeKeyOf(base)}`}))`;

const toIdentityDto = (
  row: RuleRow["identities"][number],
): PolicyIdentityInput => {
  if (row.agentId) return { type: "agent", id: row.agentId };
  if (row.agentGroupId) return { type: "agentGroup", id: row.agentGroupId };
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
          row.appConnectionScope === "project"
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
      if (row.secretScope === "organization" || row.secretScope === "project") {
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
    case "agentGroup":
      return { agentGroup: { connect: { id: i.id } } };
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
  if (i.agentGroupId)
    return { agentGroup: { connect: { id: i.agentGroupId } } };
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

// True if any identity targets the directory (agent-group / user / user-group) —
// the enterprise-gated "groups" capability. A plain agent / "any" rule is not.
const hasDirectoryIdentity = (
  identities: PolicyIdentityInput[] | undefined,
): boolean => (identities ?? []).some((i) => i.type !== "agent");

export const rowHasDirectoryIdentity = (rows: RuleRow["identities"]): boolean =>
  rows.some(
    (i) => i.agentGroupId != null || i.userId != null || i.groupId != null,
  );

// The paid-plan gate keys off the modifiers + directory identities, reusing the
// existing RuleActionGate (requireApproval → "manual_approval" [team], rateLimit
// → "rate_limit" [pro], a directory identity → "identity_directory" → "groups"
// [enterprise]).
export const gatedActions = (rule: {
  rateLimit?: number | null;
  requireApproval?: boolean | null;
  hasDirectoryIdentity?: boolean;
}): string[] => {
  const actions: string[] = [];
  if (rule.requireApproval) actions.push("manual_approval");
  if (rule.rateLimit != null) actions.push("rate_limit");
  if (rule.hasDirectoryIdentity) actions.push("identity_directory");
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
// PROJECT rule targets a specific agent or "any"; an ORG rule targets an
// agent-group / user / user-group or "any"; and (2) OWNERSHIP — every referenced
// principal must belong to the acting org (agents to the acting project). The
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
  const agentGroupIds = idsOf("agentGroup");
  const userIds = idsOf("user");
  const groupIds = idsOf("group");

  // Level restriction. The OSS edition phrases it as the capability lock it
  // is there (directory identities are a OneCLI Cloud capability); the EE
  // editions keep the scope-shaped message byte-identical.
  if (
    base.scope === "project" &&
    (agentGroupIds.length || userIds.length || groupIds.length)
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      isOssEdition()
        ? "Group and user identities are available on OneCLI Cloud."
        : "A project rule can target a specific agent or all agents.",
    );
  }
  if (base.scope === "organization" && agentIds.length) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "An organization rule targets agent-groups, users, or user-groups — not a specific agent.",
    );
  }

  // Ownership — resolve the acting org (agents are additionally scoped to the
  // acting project).
  const organizationId =
    base.scope === "organization"
      ? base.organizationId
      : (
          await db.project.findUnique({
            where: { id: base.projectId },
            select: { organizationId: true },
          })
        )?.organizationId;
  if (!organizationId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Could not resolve the acting organization.",
    );
  }
  const projectId = base.scope === "project" ? base.projectId : null;

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
          ...(projectId ? { projectId } : { project: { organizationId } }),
        },
      }),
    ),
    verify(agentGroupIds, () =>
      db.agentGroup.count({
        where: { id: { in: agentGroupIds }, organizationId },
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
// referenced connection / secret must belong to the acting org — a PROJECT rule
// may name its own project's resources or org-level ones (mirrors the equipment
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
  // PROJECT rule can only scope to its OWN project — it can't reach org-level
  // connections/secrets. An ORG rule may scope to `organization` OR `project`
  // (the level-spanning guardrail that lets each agent use its own resources).
  if (
    base.scope === "project" &&
    targets.some(
      (t) =>
        (t.kind === "app" && t.connectionScope === "organization") ||
        (t.kind === "secret" && t.secretScope === "organization"),
    )
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "A project rule's target can't scope to organization-level resources.",
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

  // Resolve the acting org (a project rule's resources are additionally scoped to
  // its own project; an org rule's to org-level resources) — same as the identity
  // ownership check.
  const organizationId =
    base.scope === "organization"
      ? base.organizationId
      : (
          await db.project.findUnique({
            where: { id: base.projectId },
            select: { organizationId: true },
          })
        )?.organizationId;
  if (!organizationId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Could not resolve the acting organization.",
    );
  }
  const projectId = base.scope === "project" ? base.projectId : null;

  // The resources this rule may reference: a PROJECT rule may name ONLY its own
  // project's resources — org-level connections/secrets are governed at the org
  // level (an org rule grants them; a project rule can't reach up to reference
  // one). An ORG rule names org-level resources. Fences on the acting org either
  // way — a foreign id is simply absent from the count.
  const ownerScope = projectId
    ? { projectId }
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
          await db.project.findUnique({
            where: { id: base.projectId },
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
    base.scope === "project"
      ? { projectId: base.projectId }
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
    }),
  );
  try {
    // The max-read + insert run under the per-scope advisory lock every other
    // priority writer (reorder / publish / rematerialize) takes — without the
    // retired auto-resort re-densifying after every write, an unlocked
    // read-then-append could mint DUPLICATE priorities under concurrency, and
    // tied priorities make the gateway's first-match order nondeterministic.
    const rule = await db.$transaction(async (tx) => {
      await lockScope(tx, base);
      const agg = await tx.policyRuleV2.aggregate({
        where: { ...base, status: "draft", isDefault: false },
        _max: { priority: true },
      });
      return tx.policyRuleV2.create({
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
    }),
  );

  try {
    const rule = await db.$transaction(async (tx) => {
      if (input.identities !== undefined) {
        await tx.policyRuleIdentity.deleteMany({ where: { ruleId: id } });
      }
      if (input.targets !== undefined) {
        await tx.policyRuleTarget.deleteMany({ where: { ruleId: id } });
      }
      return tx.policyRuleV2.update({
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
): Promise<void> => {
  const existing = await db.policyRuleV2.findFirst({
    where: { id, ...policyScope(scope), status: "draft", isDefault: false },
    select: { id: true },
  });
  if (!existing) throw new ServiceError("NOT_FOUND", "Policy rule not found.");
  await db.policyRuleV2.delete({ where: { id } });
  // Manual ordering: deleting leaves a priority gap — harmless (only relative
  // order matters to first-match; the UI numbers rows by index) and renumbered
  // densely by the next explicit reorder.
};

export const reorderPolicyRules = async (
  scope: ResourceScope,
  orderedIds: string[],
): Promise<PolicyRuleDto[]> => {
  const base = policyScope(scope);
  try {
    await db.$transaction(async (tx) => {
      // Validate + write under the per-scope advisory lock publish and the
      // coherence bridge take, so a reorder can't interleave with a concurrent
      // snapshot or rematerialization rewriting the same draft.
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
          "Rule set changed — refresh and try again.",
        );
      }
      // Ascending: index 0 → priority 1 (lowest = evaluated first / wins).
      for (const [i, id] of orderedIds.entries()) {
        await tx.policyRuleV2.update({
          where: { id },
          data: { priority: i + 1 },
        });
      }
    });
  } catch (err) {
    // A delete committed between the in-tx read and an update (deletes don't
    // take the scope lock) surfaces as P2025 — same staleness, same 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new ServiceError(
        "CONFLICT",
        "Rule set changed — refresh and try again.",
      );
    }
    throw err;
  }
  return listPolicyRules(scope, "draft");
};

// The terminal Default Rule is a per-scope singleton (isDefault). §2.4: new orgs
// deny, projects allow. `action` is derived from the scope base (not the
// caller's ResourceScope) so it stays consistent if both keys were ever set.
const defaultAction = (base: PolicyScopeBase): "allow" | "block" =>
  base.scope === "organization" ? "block" : "allow";

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
): Promise<PolicyRuleDto> => {
  const base = policyScope(scope);
  const updated = await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    const def = await ensureDefault(tx, base);
    return tx.policyRuleV2.update({
      where: { id: def.id },
      data: { action },
      include: RULE_INCLUDE,
    });
  });
  return toRuleDto(updated);
};

export interface PublishResult {
  generation: number;
  ruleCount: number;
}

// How many published generations to retain per scope for rollback; older ones
// are pruned on publish so frequent republishes don't grow the table unbounded.
const PUBLISHED_GENERATION_RETENTION = 10;

// Gate-less snapshot of the given draft rows into a fresh published generation
// (active published set = max(generation)). Callers hold the scope lock and have
// already read `draftRules`; the plan gate — if any — is the caller's job.
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
  // Prune published generations beyond the rollback retention window so frequent
  // republishes (every coherence-bridge run) can't grow the table unbounded. The
  // gateway reads only max(generation); older ones exist only for rollback.
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

// "Apply Changes": snapshot the scope's draft set into a fresh published
// generation. Active published set = max(generation); rollback (later) =
// re-snapshot a prior generation. Draft rows keep their ids (the working copy).
export const publishPolicy = async (
  scope: ResourceScope,
  userId: string,
): Promise<PublishResult> => {
  const base = policyScope(scope);
  // Manual ordering: the draft publishes exactly as the user arranged it —
  // the priorities ARE the policy (top-down first-match).
  return db.$transaction(async (tx) => {
    await lockScope(tx, base);
    await ensureDefault(tx, base);
    const draftRules = await tx.policyRuleV2.findMany({
      where: { ...base, status: "draft" },
      include: RULE_INCLUDE,
    });
    // Re-assert the plan gate: what's about to go live must still be entitled.
    const actions = [
      ...new Set(
        draftRules.flatMap((r) =>
          gatedActions({
            rateLimit: r.rateLimit,
            requireApproval: r.requireApproval,
            hasDirectoryIdentity: rowHasDirectoryIdentity(r.identities),
          }),
        ),
      ),
    ];
    if (actions.length > 0) {
      await getRuleActionGate().assertAllowed(scope, actions);
    }
    // Re-assert the granular-scoping entitlement too — symmetric with the plan
    // gate above: a session policy entitled at author time must still be entitled
    // (and still valid against the connection) to go live. No-ops for behavioral /
    // absent conditions; the per-provider validator is a cheap metadata check.
    for (const r of draftRules) {
      if (!isSessionPolicy(r.conditions)) continue;
      const connTargets = r.targets
        .filter((t) => t.kind === "connection" && t.appConnectionId != null)
        .map((t) => ({
          kind: "connection" as const,
          connectionId: t.appConnectionId as string,
        }));
      await assertSessionPolicyValid(
        base,
        connTargets,
        r.conditions,
        r.action as "allow" | "block",
      );
    }
    return snapshotDraftRules(tx, base, draftRules, userId);
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
      connectionScope: "organization" | "project" | null;
    }
  | { kind: "connection"; connectionId: string; tools: string[] }
  | { kind: "secret"; secretId: string };

/** One translated rule to materialize (the translator's `NewRule`, structurally
 * — agent identities + network/app/connection/secret targets). */
export interface BackfillRuleInput {
  priority: number;
  isDefault: boolean;
  /** Rule origin — the coherence bridge re-materializes only the DERIVED sources
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
 *
 * `replace: true` is the pre-cutover HEAL path: instead of skipping an
 * already-published scope, it DISCARDS the scope's stored v2 (draft + every
 * published generation) and re-writes it fresh from the current translation. Used
 * to correct a scope diverged by the source-classification bug — an app-permission
 * that falls back to a network target was tagged `source="custom"`, so the bridge
 * both kept it and re-derived it → runaway duplication (root-fixed in the
 * EE translation; this re-tags the already-stored rows). Safe only
 * pre-cutover — the sole caller runs from the boot hook, which fires only while
 * `POLICY_EDITING_ENABLED` is off (after cutover the console, not the old model,
 * is authoritative).
 */
export const backfillPublishScope = async (
  scope: ResourceScope,
  rules: BackfillRuleInput[],
  opts?: { replace?: boolean },
): Promise<BackfillResult> => {
  const base = policyScope(scope);
  return db.$transaction(
    async (tx) => {
      await lockScope(tx, base);
      if (opts?.replace) {
        // Discard the scope's stored v2 (draft + every published generation) so the
        // fresh translation fully replaces it; identities/targets cascade via their
        // FK (onDelete: Cascade).
        await tx.policyRuleV2.deleteMany({ where: base });
      } else {
        const published = await tx.policyRuleV2.count({
          where: { ...base, status: "published" },
        });
        if (published > 0) {
          return { skipped: true, generation: null, ruleCount: 0 };
        }
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
      // An empty scope (e.g. a ruleless project — the common case) publishes
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

// ── Step-5 coherence bridge (persist half) ───────────────────────────────────

/** A derived rule to re-materialize, carrying BOTH priorities: `priority` for
 * the draft insert (interleaved against the DRAFT customs) and
 * `publishPriority` for the published generation (interleaved against the
 * PUBLISHED customs — the two custom sets can differ while edits are staged). */
export type RematerializedDerivedInput = BackfillRuleInput & {
  publishPriority: number;
};

/** The publish half of a rematerialization plan: the CURRENT published
 * generation's rows (read under the same lock) + the new priorities for its
 * custom rows once the fresh derived rules interleave among them. */
export interface RematerializedPublishPlan {
  publishedRows: PolicyRuleRow[];
  publishedCustomPriorities: { id: string; priority: number }[];
}

export interface LastPublishDto {
  generation: number;
  ruleCount: number;
  appliedAt: Date;
  /** Who clicked Apply — null for a system publish (the coherence bridge's
   * rematerialization) or a pre-provenance generation. */
  appliedBy: { name: string | null; email: string } | null;
}

/** The scope's most recent publish — who applied it and when. Null = never
 * published. A zero-schema read: the newest generation's rows already carry the
 * author (`createdByUserId` → the `createdByUser` relation) and the publish
 * instant (`createdAt`). */
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

/** Read the scope's current (max-generation) published rule set. Empty rows +
 * generation 0 when the scope has never published. */
export const readCurrentPublishedGeneration = async (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
): Promise<{ generation: number; rows: RuleRow[] }> => {
  const maxGen = await tx.policyRuleV2.aggregate({
    where: { ...base, status: "published" },
    _max: { generation: true },
  });
  const generation = maxGen._max.generation ?? 0;
  if (generation === 0) return { generation: 0, rows: [] };
  const rows = await tx.policyRuleV2.findMany({
    where: { ...base, status: "published", generation },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  return { generation, rows };
};

/**
 * Build the publish set for a rematerialization — PURE, so it's directly
 * unit-testable. The set is the CURRENT PUBLISHED generation's KEPT rows —
 * everything whose source is NOT in `derivedSources` (customs + the default,
 * and post-adoption any straggler `app_permission` row awaiting its re-tag) —
 * re-prioritized to interleave with the fresh derived (the default's content
 * carried verbatim with its priority normalized below — absent stays absent,
 * which ≡ Allow under the uniform per-level law) plus the fresh derived rows
 * at their publish priorities. The kept set is the COMPLEMENT of the derived
 * list so the two partitions can never disagree. The DRAFT never enters: a
 * user's staged edits cannot reach the published set through a
 * rematerialization — only "Apply Changes" publishes the draft.
 */
export const buildRematerializedPublishSet = (
  publishedRows: PolicyRuleRow[],
  publishedCustomPriorities: { id: string; priority: number }[],
  freshDerived: { row: PolicyRuleRow; publishPriority: number }[],
  derivedSources: string[],
): PolicyRuleRow[] => {
  const priorityById = new Map(
    publishedCustomPriorities.map((p) => [p.id, p.priority]),
  );
  const kept = publishedRows.filter((r) => !derivedSources.includes(r.source));
  // The Default Rule is selected by flag, never by priority — but its priority
  // must still be UNIQUE within the generation: a tie with an explicit row
  // would make the read-back order (ORDER BY priority) nondeterministic and
  // silently defeat the skip-if-unchanged compare. One slot past every
  // explicit priority is deterministic and collision-free.
  const explicitPriorities = [
    ...kept
      .filter((r) => !r.isDefault)
      .map((r) => priorityById.get(r.id) ?? r.priority),
    ...freshDerived.map((f) => f.publishPriority),
  ];
  const defaultPriority =
    explicitPriorities.length > 0 ? Math.max(...explicitPriorities) + 1 : 0;
  const keptRows = kept.map((r) => ({
    ...r,
    priority: r.isDefault
      ? defaultPriority
      : (priorityById.get(r.id) ?? r.priority),
  }));
  const derived = freshDerived.map(({ row, publishPriority }) => ({
    ...row,
    priority: publishPriority,
  }));
  return [...keptRows, ...derived];
};

/**
 * The identity-tuple key every rule content signature shares
 * (`publishSetSignature`, the adoption pass's `adoptionRowSignature`, the
 * compaction pass's group key) — ONE definition so the identity model can
 * never silently diverge between them.
 */
export const identityRowKeys = (
  identities: {
    agentId: string | null;
    agentGroupId: string | null;
    userId: string | null;
    groupId: string | null;
  }[],
): string[] =>
  identities
    .map(
      (x) =>
        `${x.agentId ?? ""}|${x.agentGroupId ?? ""}|${x.userId ?? ""}|${x.groupId ?? ""}`,
    )
    .sort();

/**
 * Canonical behavior signature of a publish set — PURE. Two sets with the same
 * signature are indistinguishable to the engine, so re-publishing is a no-op.
 * Order is captured positionally (sorted by priority, values then dropped, so
 * absolute renumbering doesn't churn); row `id`s, `logicalId`s (derived ones
 * are regenerated every rematerialization), timestamps, and the publish author
 * are excluded.
 */
export const publishSetSignature = (rows: PolicyRuleRow[]): string =>
  JSON.stringify(
    rows
      .slice()
      // The Default Rule's position is meaningless (the engine selects it by
      // flag) and its stored priority varies by era (backfill: after the
      // explicit rules; a user Apply: 0) — pin defaults last so a
      // position-only difference of the default never defeats the skip.
      .sort((a, b) =>
        a.isDefault === b.isDefault
          ? a.priority - b.priority
          : a.isDefault
            ? 1
            : -1,
      )
      .map((r) => ({
        s: r.source,
        d: r.isDefault,
        e: r.enabled,
        n: r.name,
        de: r.description ?? null,
        a: r.action,
        rl: r.rateLimit,
        rw: r.rateLimitWindow,
        ra: r.requireApproval,
        c: r.conditions ?? null,
        i: identityRowKeys(r.identities),
        t: r.targets
          .map((t) =>
            JSON.stringify({
              k: t.kind,
              ap: t.appProvider,
              at: t.appTools,
              acs: t.appConnectionScope,
              ac: t.appConnectionId,
              si: t.secretId,
              ss: t.secretScope,
              h: t.hostPattern,
              p: t.pathPattern,
              m: t.method,
            }),
          )
          .sort(),
      })),
  );

/**
 * The bridge's persist half — runs INSIDE the caller's transaction (the coherence
 * service holds `lockScope` and reads the old model + kept custom rules under the
 * SAME lock, so the write reflects the state at lock time — no read-then-write
 * race). Replaces the scope's bridge-owned draft rules (`app_permission`/
 * `blocklist`/`equipment`), re-priorities the kept DRAFT custom rules to slot
 * the fresh derived rules around them while preserving the customs' MANUAL
 * relative order (the pinned merge), and publishes a fresh generation
 * built from the CURRENT PUBLISHED customs + default + the fresh derived rules
 * — never from the draft, so a user's staged edits stay staged until they
 * explicitly Apply (`publishPolicy`). Skips the publish entirely when the new
 * set's behavior signature equals the current generation's (no more no-op
 * generations churning the rollback window). Gate-less because it materializes
 * EXISTING, already-entitled policy, not a new user edit.
 *
 * Note: derived rules are delete+re-inserted each run, so each gets a fresh
 * `logicalId`. Blocklist rules never carry a rate limit; app-permission rows CAN
 * (`collapseAction` maps old rate_limit rows to allow+rateLimit) — while they
 * were bridge-derived their counters reset on re-materialization (a pre-existing,
 * window-bounded property); post-adoption they are kept rows with stable
 * logicalIds. Kept rows keep their ids (only priority is updated), so a kept
 * rate rule's counter stays stable.
 */
export const applyRematerialization = async (
  tx: Prisma.TransactionClient,
  base: PolicyScopeBase,
  derived: RematerializedDerivedInput[],
  customPriorities: { id: string; priority: number }[],
  publish: RematerializedPublishPlan,
): Promise<PublishResult> => {
  // Replace only the bridge-owned draft rules (the DERIVED sources — see
  // `bridgeDerivedSources`); everything else stays put. `equipment` (step 8)
  // is derived from the live equipment model. At EDITING=1 `app_permission`
  // leaves the derived set (adopted as user-owned custom rules), so straggler
  // app_permission rows are preserved verbatim, never deleted here.
  await tx.policyRuleV2.deleteMany({
    where: {
      ...base,
      status: "draft",
      source: { in: bridgeDerivedSources() },
    },
  });
  const createdIds: string[] = [];
  for (const d of derived) {
    const created = await tx.policyRuleV2.create({
      data: {
        ...base,
        status: "draft",
        generation: 0,
        priority: d.priority,
        isDefault: d.isDefault,
        source: d.source,
        enabled: true,
        name: d.name,
        action: d.action,
        rateLimit: d.rateLimit ?? null,
        rateLimitWindow: d.rateLimitWindow ?? null,
        requireApproval: d.requireApproval,
        conditions: jsonInput(d.conditions),
        identities: { create: d.identities.map(identityCreate) },
        targets: { create: d.targets.map(backfillTargetCreate) },
      },
    });
    createdIds.push(created.id);
  }
  // Re-priority the kept custom rules to interleave with the new derived ones.
  for (const { id, priority } of customPriorities) {
    await tx.policyRuleV2.update({ where: { id }, data: { priority } });
  }
  // Don't create a project default here: under the uniform per-level law an
  // absent project default ≡ Allow, and the project default is user-owned
  // (setPolicyDefaultAction) — a persisted one survives rematerialization
  // untouched (the deleteMany above only clears derived sources). The org
  // default is ensured because the org terminal must always exist.
  if (base.scope === "organization") {
    await ensureDefault(tx, base);
  }
  // Publish set = current published customs+default + the fresh derived rows
  // (re-read with their relations, aligned to the input order by created id).
  const freshRows = await tx.policyRuleV2.findMany({
    where: { ...base, id: { in: createdIds } },
    include: RULE_INCLUDE,
  });
  const rowById = new Map(freshRows.map((r) => [r.id, r]));
  const freshDerived = derived.map((d, i) => {
    const id = createdIds[i];
    const row = id === undefined ? undefined : rowById.get(id);
    if (!row) throw new Error("rematerialized derived row disappeared mid-tx");
    return { row, publishPriority: d.publishPriority };
  });
  const publishRows = buildRematerializedPublishSet(
    publish.publishedRows,
    publish.publishedCustomPriorities,
    freshDerived,
    bridgeDerivedSources(),
  );
  // Skip the no-op publish: identical behavior → keep the current generation.
  if (
    publishSetSignature(publishRows) ===
    publishSetSignature(publish.publishedRows)
  ) {
    const generation = publish.publishedRows[0]?.generation ?? 0;
    return { generation, ruleCount: publish.publishedRows.length };
  }
  return snapshotDraftRules(tx, base, publishRows, null);
};
