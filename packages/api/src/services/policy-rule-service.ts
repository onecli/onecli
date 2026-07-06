import { db, Prisma } from "@onecli/db";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import {
  scopeWhere,
  scopeCreate,
  scopeOwnership,
  isOrgScope,
} from "./resource-scope";
import {
  type CreatePolicyRuleInput,
  type UpdatePolicyRuleInput,
  type RuleCondition,
  type PolicyMode,
} from "../validations/policy-rule";
import {
  getAppPermissionDefinition,
  mapRuleActionToPermission,
  allGroupTools,
  type AppTool,
  type AppToolGroup,
  type AppPermissionLevel,
  type AppPermissionDefinition,
  type AppPermissionSetting,
} from "../apps/app-permissions";
import { getRuleActionGate } from "../providers";

export type { CreatePolicyRuleInput, UpdatePolicyRuleInput };

/** Marker in PolicyRule.metadata.source for rows managed by the app-permission catalog. */
const APP_PERMISSION_SOURCE = "app_permission";

const RULE_SELECT = {
  id: true,
  name: true,
  hostPattern: true,
  pathPattern: true,
  method: true,
  action: true,
  enabled: true,
  agentId: true,
  rateLimit: true,
  rateLimitWindow: true,
  scope: true,
  metadata: true,
  conditions: true,
  createdAt: true,
} as const;

const isAppPermissionMetadata = (metadata: unknown): boolean =>
  typeof metadata === "object" &&
  metadata !== null &&
  (metadata as { source?: unknown }).source === APP_PERMISSION_SOURCE;

/**
 * App-permission rows expose only their catalog handle (metadata.provider +
 * metadata.toolId); the endpoint mapping they carry is server-internal and
 * must not appear in API responses. Custom rules are the user's own data and
 * keep their fields.
 */
const redactAppPermissionRule = <
  T extends {
    metadata: unknown;
    hostPattern: string;
    pathPattern: string | null;
    method: string | null;
  },
>(
  rule: T,
): T | Omit<T, "hostPattern" | "pathPattern" | "method"> => {
  if (!isAppPermissionMetadata(rule.metadata)) return rule;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hostPattern, pathPattern, method, ...rest } = rule;
  return rest;
};

export const listPolicyRules = async (scope: ResourceScope) => {
  const rules = await db.policyRule.findMany({
    where: scopeWhere(scope),
    select: RULE_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rules.map(redactAppPermissionRule);
};

export const getPolicyRule = async (scope: ResourceScope, ruleId: string) => {
  const rule = await db.policyRule.findFirst({
    where: scopeOwnership(scope, ruleId),
    select: RULE_SELECT,
  });
  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");
  return redactAppPermissionRule(rule);
};

export const createPolicyRule = async (
  scope: ResourceScope,
  input: CreatePolicyRuleInput,
) => {
  await getRuleActionGate().assertAllowed(scope, [input.action]);

  const name = input.name.trim();
  const orgScope = isOrgScope(scope);

  const agentId = orgScope ? null : input.agentId || null;

  if (agentId && scope.projectId) {
    const agent = await db.agent.findFirst({
      where: { id: agentId, projectId: scope.projectId },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  }

  return db.policyRule.create({
    data: {
      name,
      hostPattern: input.hostPattern.trim(),
      pathPattern: input.pathPattern?.trim() || null,
      method: input.method || null,
      action: input.action,
      enabled: input.enabled,
      agentId,
      rateLimit:
        input.action === "rate_limit" ? (input.rateLimit ?? null) : null,
      rateLimitWindow:
        input.action === "rate_limit" ? (input.rateLimitWindow ?? null) : null,
      ...(input.conditions ? { conditions: input.conditions } : {}),
      ...scopeCreate(scope),
    },
    select: {
      id: true,
      name: true,
      hostPattern: true,
      pathPattern: true,
      method: true,
      action: true,
      enabled: true,
      agentId: true,
      rateLimit: true,
      rateLimitWindow: true,
      conditions: true,
      createdAt: true,
    },
  });
};

export const updatePolicyRule = async (
  scope: ResourceScope,
  ruleId: string,
  input: UpdatePolicyRuleInput,
) => {
  if (input.action !== undefined)
    await getRuleActionGate().assertAllowed(scope, [input.action]);

  const rule = await db.policyRule.findFirst({
    where: scopeOwnership(scope, ruleId),
    select: {
      id: true,
      action: true,
      rateLimit: true,
      rateLimitWindow: true,
      metadata: true,
    },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  // App-permission rows derive their endpoint fields from the internal
  // catalog; direct edits would desync them from the tool they represent.
  if (
    isAppPermissionMetadata(rule.metadata) &&
    (input.hostPattern !== undefined ||
      input.pathPattern !== undefined ||
      input.method !== undefined)
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      "App-permission rule endpoints are managed automatically; change app permissions via PUT /rules/permissions/{provider} (or /org/rules/permissions/{provider} for organization rules)",
    );
  }

  // A rate_limit rule without a valid config would never be enforced by the
  // gateway; reject writes that would produce one (an unconfigured row must
  // not exist — it could otherwise shadow an all-agents rule while being
  // dropped from evaluation).
  const touchesRateConfig =
    input.action !== undefined ||
    input.rateLimit !== undefined ||
    input.rateLimitWindow !== undefined;
  if (touchesRateConfig && (input.action ?? rule.action) === "rate_limit") {
    const nextLimit =
      input.rateLimit !== undefined ? input.rateLimit : rule.rateLimit;
    const nextWindow =
      input.rateLimitWindow !== undefined
        ? input.rateLimitWindow
        : rule.rateLimitWindow;
    if (!nextLimit || nextLimit <= 0 || !nextWindow)
      throw new ServiceError(
        "BAD_REQUEST",
        "Rate limit rules require a rate limit and window",
      );
  }

  const orgScope = isOrgScope(scope);

  if (!orgScope && input.agentId) {
    const agent = await db.agent.findFirst({
      where: { id: input.agentId, projectId: scope.projectId! },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  }

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name.trim();
  if (input.hostPattern !== undefined)
    data.hostPattern = input.hostPattern.trim();
  if (input.pathPattern !== undefined)
    data.pathPattern = input.pathPattern?.trim() || null;
  if (input.method !== undefined) data.method = input.method || null;
  if (input.action !== undefined) {
    data.action = input.action;
    if (input.action !== "rate_limit") {
      data.rateLimit = null;
      data.rateLimitWindow = null;
    }
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (!orgScope && input.agentId !== undefined)
    data.agentId = input.agentId || null;
  if (input.rateLimit !== undefined) data.rateLimit = input.rateLimit;
  if (input.rateLimitWindow !== undefined)
    data.rateLimitWindow = input.rateLimitWindow;
  if (input.conditions !== undefined)
    data.conditions =
      input.conditions === null ? Prisma.JsonNull : input.conditions;

  await db.policyRule.update({
    where: { id: ruleId },
    data,
  });
};

export const deletePolicyRule = async (
  scope: ResourceScope,
  ruleId: string,
) => {
  const rule = await db.policyRule.findFirst({
    where: scopeOwnership(scope, ruleId),
    select: { id: true },
  });

  if (!rule) throw new ServiceError("NOT_FOUND", "Policy rule not found");

  await db.policyRule.delete({ where: { id: ruleId } });
};

export const listAppPermissionRules = async (
  scope: ResourceScope,
  provider: string,
) => {
  return db.policyRule.findMany({
    where: {
      ...scopeWhere(scope),
      AND: [
        { metadata: { path: ["source"], equals: APP_PERMISSION_SOURCE } },
        { metadata: { path: ["provider"], equals: provider } },
      ],
    },
    select: {
      id: true,
      action: true,
      metadata: true,
      conditions: true,
      pathPattern: true,
      method: true,
      agentId: true,
    },
  });
};

export interface AppPermissionChange {
  toolId: string;
  permission: AppPermissionSetting;
  tool: AppTool;
}

interface RuleVariant {
  pathPattern: string;
  method: string | null;
}

const allRuleVariants = (tool: AppTool): RuleVariant[] => {
  const paths = [tool.pathPattern, ...(tool.aliasPatterns ?? [])];
  const methods: (string | null)[] = tool.methods ?? [tool.method ?? null];
  return paths.flatMap((p) =>
    methods.map((m) => ({ pathPattern: p, method: m })),
  );
};

type AppPermissionRuleRow = Awaited<
  ReturnType<typeof listAppPermissionRules>
>[number];

const metadataToolId = (rule: AppPermissionRuleRow): string | undefined => {
  if (
    rule.metadata == null ||
    typeof rule.metadata !== "object" ||
    !("toolId" in rule.metadata)
  )
    return undefined;
  return (rule.metadata as { toolId: string }).toolId;
};

const parseRuleConditions = (value: unknown): RuleCondition[] | null =>
  Array.isArray(value) && value.length > 0 ? (value as RuleCondition[]) : null;

export type AppPermissionState = {
  permission: AppPermissionLevel;
  conditions: unknown[];
};

export type AppPermissionStatesResult = {
  /** Tool states from the all-agents rows (agentId null). */
  defaults: Record<string, AppPermissionState>;
  /** Per-agent override layers: agentId → toolId → state. */
  byAgent: Record<string, Record<string, AppPermissionState>>;
};

/** Fold app-permission rule rows into per-layer tool states. */
export const buildAppPermissionStates = (
  rules: AppPermissionRuleRow[],
): AppPermissionStatesResult => {
  const defaults: Record<string, AppPermissionState> = {};
  const byAgent: Record<string, Record<string, AppPermissionState>> = {};
  for (const rule of rules) {
    const toolId = metadataToolId(rule);
    if (toolId === undefined) continue;
    const state: AppPermissionState = {
      permission: mapRuleActionToPermission(rule.action),
      conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
    };
    if (rule.agentId) {
      (byAgent[rule.agentId] ??= {})[toolId] = state;
    } else {
      defaults[toolId] = state;
    }
  }
  return { defaults, byAgent };
};

/**
 * Resolve permission-change toolIds against the app's definition. Returns the
 * unknown toolId instead of throwing so routes can answer 400, not 500.
 */
export const resolvePermissionChanges = (
  definition: AppPermissionDefinition,
  changes: { toolId: string; permission: AppPermissionSetting }[],
): { resolved: AppPermissionChange[] } | { unknownToolId: string } => {
  const toolMap = new Map(
    definition.groups.flatMap(allGroupTools).map((tool) => [tool.id, tool]),
  );
  const resolved: AppPermissionChange[] = [];
  for (const change of changes) {
    const tool = toolMap.get(change.toolId);
    if (!tool) return { unknownToolId: change.toolId };
    resolved.push({
      toolId: change.toolId,
      permission: change.permission,
      tool,
    });
  }
  return { resolved };
};

/** Gateway evaluation priority: Block > ManualApproval > RateLimit > Allow. */
const ACTION_STRICTNESS: Record<string, number> = {
  allow: 0,
  rate_limit: 1,
  manual_approval: 2,
  block: 3,
};

const actionStrictness = (action: string): number =>
  ACTION_STRICTNESS[action] ?? 0;

interface PermissionCreateOp {
  toolId: string;
  tool: AppTool;
  pathPattern: string;
  method: string | null;
  action: string;
  agentId: string | null;
  conditions: RuleCondition[] | null;
}

interface PermissionUpdateOp {
  ruleId: string;
  action: string;
  /** undefined = leave untouched; null = clear; array = set */
  conditions?: RuleCondition[] | null;
}

/**
 * Fan a group-wildcard change out to one change per tool in the group; the
 * wildcard entry itself is replaced with `wildcardReplacement` (a permission
 * the diff turns into "delete the wildcard rows"). Request-explicit per-tool
 * changes win over fanned-out ones.
 */
const fanOutWildcardChanges = (
  changes: AppPermissionChange[],
  wildcardGroups: Map<string, AppToolGroup>,
  shouldFanOut: (group: AppToolGroup, change: AppPermissionChange) => boolean,
  wildcardReplacement: AppPermissionSetting,
): AppPermissionChange[] => {
  if (!changes.some((c) => wildcardGroups.has(c.toolId))) return changes;

  const explicit = new Map<string, AppPermissionChange>();
  const fanned = new Map<string, AppPermissionChange>();
  for (const change of changes) {
    const group = wildcardGroups.get(change.toolId);
    if (!group || !shouldFanOut(group, change)) {
      explicit.set(change.toolId, change);
      continue;
    }
    explicit.set(change.toolId, {
      toolId: change.toolId,
      permission: wildcardReplacement,
      tool: change.tool,
    });
    for (const tool of group.tools) {
      fanned.set(tool.id, {
        toolId: tool.id,
        permission: change.permission,
        tool,
      });
    }
  }
  for (const [toolId, change] of explicit) fanned.set(toolId, change);
  return [...fanned.values()];
};

export const setAppPermissionsService = async (
  scope: ResourceScope,
  provider: string,
  appName: string,
  changes: AppPermissionChange[],
  conditions?: RuleCondition[],
  policyMode?: PolicyMode,
  agentId?: string | null,
) => {
  // Layer being written: null = the all-agents defaults, otherwise one agent's
  // override layer. Agent layers are mode-independent: every non-inherit
  // setting materializes explicit rows (an explicit "allow" is what shadows an
  // all-agents block in the gateway), and "inherit" deletes the agent's rows.
  const layer = agentId || null;
  const orgScope = isOrgScope(scope);

  if (layer && orgScope)
    throw new ServiceError(
      "BAD_REQUEST",
      "Organization app permissions cannot target an agent",
    );
  if (!layer && changes.some((c) => c.permission === "inherit"))
    throw new ServiceError(
      "BAD_REQUEST",
      "Only agent-scoped app permissions can be set to inherit",
    );
  if (layer) {
    const agent = await db.agent.findFirst({
      where: { id: layer, projectId: scope.projectId! },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  }

  await getRuleActionGate().assertAllowed(
    scope,
    changes.map((c) => c.permission).filter((p) => p !== "inherit"),
  );

  const isDenyMode = policyMode === "deny";
  const definition = getAppPermissionDefinition(provider);
  const wildcardGroups = new Map<string, AppToolGroup>();
  for (const group of definition?.groups ?? []) {
    if (group.wildcard) wildcardGroups.set(group.wildcard.id, group);
  }

  const existing = await listAppPermissionRules(scope, provider);
  const layerRows = existing.filter((r) => (r.agentId ?? null) === layer);
  const allAgentsRows = existing.filter((r) => r.agentId == null);
  const agentRowToolIds = new Set(
    existing
      .filter((r) => r.agentId != null)
      .map(metadataToolId)
      .filter((id): id is string => id !== undefined),
  );
  const groupHasAgentRows = (group: AppToolGroup): boolean =>
    (group.wildcard ? [group.wildcard, ...group.tools] : group.tools).some(
      (tool) => agentRowToolIds.has(tool.id),
    );

  // Wildcard alignment: the gateway shadows by exact endpoint signature, so a
  // group can never mix an agent override with a live wildcard row.
  // W1 — agent layers never hold wildcard rows: fan wildcard changes per-tool.
  // W3 — an all-agents wildcard write goes per-tool while any agent override
  //      exists in the group (without overrides it stays byte-for-byte today's
  //      wildcard write).
  const effectiveChanges = layer
    ? fanOutWildcardChanges(changes, wildcardGroups, () => true, "inherit")
    : fanOutWildcardChanges(
        changes,
        wildcardGroups,
        (group, change) =>
          (isDenyMode
            ? change.permission !== "block"
            : change.permission !== "allow") && groupHasAgentRows(group),
        isDenyMode ? "block" : "allow",
      );

  const existingByToolId = new Map<string, AppPermissionRuleRow[]>();
  for (const rule of layerRows) {
    const toolId = metadataToolId(rule);
    if (toolId === undefined) continue;
    const arr = existingByToolId.get(toolId) ?? [];
    arr.push(rule);
    existingByToolId.set(toolId, arr);
  }

  const toCreate: PermissionCreateOp[] = [];
  const toUpdate: PermissionUpdateOp[] = [];
  const toDelete: string[] = [];

  const conditionsProvided = conditions !== undefined;
  const requestConditions = conditionsProvided
    ? conditions.length > 0
      ? conditions
      : null
    : undefined;

  for (const change of effectiveChanges) {
    const existingRules = existingByToolId.get(change.toolId) ?? [];
    const { permission } = change;

    // "Absence" settings delete the layer's rows: inherit (agent layers), or
    // the mode default for the all-agents layer (allow-mode "allow" /
    // deny-mode "block").
    if (permission === "inherit") {
      for (const rule of existingRules) toDelete.push(rule.id);
      continue;
    }
    const removesRows =
      !layer && (isDenyMode ? permission === "block" : permission === "allow");
    if (removesRows) {
      for (const rule of existingRules) toDelete.push(rule.id);
      continue;
    }

    for (const rule of existingRules) {
      if (rule.action !== permission || conditionsProvided) {
        toUpdate.push({
          ruleId: rule.id,
          action: permission,
          conditions: requestConditions,
        });
      }
    }
    const existingKeys = new Set(
      existingRules.map((r) => `${r.pathPattern}\0${r.method ?? ""}`),
    );
    for (const variant of allRuleVariants(change.tool)) {
      if (
        !existingKeys.has(`${variant.pathPattern}\0${variant.method ?? ""}`)
      ) {
        toCreate.push({
          toolId: change.toolId,
          tool: change.tool,
          pathPattern: variant.pathPattern,
          method: variant.method,
          action: permission,
          agentId: layer,
          conditions: requestConditions ?? null,
        });
      }
    }
  }

  // W2 — the first agent override landing in a group expands the all-agents
  // wildcard into per-tool rows (same action, carrying the wildcard rows' own
  // conditions), so both layers hold signature-aligned rows.
  if (layer && definition) {
    for (const group of definition.groups) {
      const wildcard = group.wildcard;
      if (!wildcard) continue;
      const groupToolIds = new Set(group.tools.map((t) => t.id));
      const touchesGroup = effectiveChanges.some(
        (c) => groupToolIds.has(c.toolId) && c.permission !== "inherit",
      );
      if (!touchesGroup) continue;
      const wildcardRows = allAgentsRows.filter(
        (r) => metadataToolId(r) === wildcard.id,
      );
      if (wildcardRows.length === 0) continue;
      // Deterministic pick: variants are written uniformly, so divergent
      // wildcard rows only exist in legacy data — resolve fail-closed.
      const strictestWildcardRow = wildcardRows.reduce((a, b) =>
        actionStrictness(b.action) > actionStrictness(a.action) ? b : a,
      );
      const wildcardAction = strictestWildcardRow.action;
      const wildcardConditions = parseRuleConditions(
        strictestWildcardRow.conditions,
      );
      for (const rule of wildcardRows) toDelete.push(rule.id);

      for (const tool of group.tools) {
        const toolRows = allAgentsRows.filter(
          (r) => metadataToolId(r) === tool.id,
        );
        for (const rule of toolRows) {
          // Never loosen: pre-expansion, the most restrictive of (wildcard,
          // per-tool row) won at evaluation — a stricter per-tool row keeps
          // its own action and conditions.
          if (actionStrictness(rule.action) > actionStrictness(wildcardAction))
            continue;
          toUpdate.push({
            ruleId: rule.id,
            action: wildcardAction,
            conditions: wildcardConditions,
          });
        }
        const existingKeys = new Set(
          toolRows.map((r) => `${r.pathPattern}\0${r.method ?? ""}`),
        );
        for (const variant of allRuleVariants(tool)) {
          if (
            !existingKeys.has(`${variant.pathPattern}\0${variant.method ?? ""}`)
          ) {
            toCreate.push({
              toolId: tool.id,
              tool,
              pathPattern: variant.pathPattern,
              method: variant.method,
              action: wildcardAction,
              agentId: null,
              conditions: wildcardConditions,
            });
          }
        }
      }
    }
  }

  const scopeDeleteWhere = scope.organizationId
    ? { organizationId: scope.organizationId }
    : { projectId: scope.projectId! };

  await db.$transaction(async (tx) => {
    if (toDelete.length > 0) {
      await tx.policyRule.deleteMany({
        where: { id: { in: toDelete }, ...scopeDeleteWhere },
      });
    }

    for (const op of toUpdate) {
      await tx.policyRule.update({
        where: { id: op.ruleId },
        data: {
          action: op.action,
          ...(op.conditions !== undefined
            ? {
                conditions:
                  op.conditions && op.conditions.length > 0
                    ? op.conditions
                    : Prisma.JsonNull,
              }
            : {}),
        },
      });
    }

    for (const op of toCreate) {
      await tx.policyRule.create({
        data: {
          ...scopeCreate(scope),
          agentId: orgScope ? null : op.agentId,
          name: op.tool.name,
          hostPattern: op.tool.hostPattern,
          pathPattern: op.pathPattern,
          method: op.method,
          action: op.action,
          enabled: true,
          metadata: {
            source: APP_PERMISSION_SOURCE,
            provider,
            toolId: op.toolId,
          },
          ...(op.conditions && op.conditions.length > 0
            ? { conditions: op.conditions }
            : {}),
        },
      });
    }
  });

  return {
    created: toCreate.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
  };
};

export const countOverlappingRulesForHost = async (
  scope: ResourceScope,
  hostPatterns: string[],
) => {
  if (hostPatterns.length === 0) return 0;
  return db.policyRule.count({
    where: {
      ...scopeWhere(scope),
      enabled: true,
      hostPattern: { in: hostPatterns },
      NOT: {
        metadata: { path: ["source"], equals: APP_PERMISSION_SOURCE },
      },
    },
  });
};

/** Custom (non-app-permission) rules overlapping any of an app's hosts. */
export const countOverlappingRulesForApp = async (
  scope: ResourceScope,
  provider: string,
) => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return 0;
  const hostPatterns = [
    ...new Set(
      def.groups.flatMap((g) => allGroupTools(g).map((t) => t.hostPattern)),
    ),
  ];
  return countOverlappingRulesForHost(scope, hostPatterns);
};

export const providerDisplayName = (provider: string) =>
  provider.charAt(0).toUpperCase() + provider.slice(1).replace(/-/g, " ");
