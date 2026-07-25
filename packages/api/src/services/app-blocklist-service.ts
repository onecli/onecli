import { randomUUID } from "node:crypto";
import { db, type Prisma } from "@onecli/db";
import type { ResourceScope } from "./resource-scope";
import { ServiceError } from "./errors";
import { policyScope, lockScope, type PolicyScopeBase } from "./policy-service";

/**
 * The per-app host blocklist, on the v2 policy model.
 *
 * A blocked host IS a policy rule: `action="block"` over a network target on the
 * host, tagged `source="blocklist"` so the console renders it as feature-owned
 * rather than hand-authored. The app registry declares which hosts belong to
 * which app (`AppDefinition.blocklist`), so no stored provenance is needed — a
 * rule belongs to an app exactly when its host pattern is one the app declares.
 * Blocking an arbitrary host is a policy rule authored in the console, not an
 * app-scoped concept.
 *
 * Writes are LOCKSTEP: each change lands in the scope's draft AND in the live
 * published generation, so a block takes effect immediately without publishing
 * whatever else the user has staged in the draft. Both rows share a `logicalId`,
 * which is how a draft row and its published twin find each other.
 */

export interface BlocklistHostState {
  hostId: string;
  ruleId: string | null;
  enabled: boolean;
  custom: boolean;
  name: string;
  hostPattern: string;
  scope: "organization" | "project" | null;
}

type BlocklistHost = { id: string; name: string; hostPattern: string };

const BLOCKLIST_SOURCE = "blocklist";

/** Every path on the host — blocklists are host-wide by construction. */
const ANY_PATH = "/*";

type Tx = Prisma.TransactionClient;

/** The generation the gateway is currently enforcing, or null when the scope has
 * never published (a fresh or unseeded scope — nothing is enforced there yet, so
 * a draft-only write is consistent and the first publish carries it live). */
const liveGeneration = async (
  tx: Tx,
  base: PolicyScopeBase,
): Promise<number | null> => {
  const agg = await tx.policyRuleV2.aggregate({
    where: { ...base, status: "published" },
    _max: { generation: true },
  });
  return agg._max.generation;
};

/**
 * Where a block belongs in a first-match set: after the existing blocks, before
 * everything looser. Mirrors the strictness order the engine and the console
 * share (block ≺ approval ≺ rate-limit ≺ allow) — appending instead would let an
 * earlier allow win and the block would never fire.
 */
const insertPriority = async (
  tx: Tx,
  base: PolicyScopeBase,
  where: { status: string; generation?: number },
): Promise<number> => {
  const rules = await tx.policyRuleV2.findMany({
    where: { ...base, ...where, isDefault: false },
    select: { priority: true, action: true },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  const firstLooser = rules.find((r) => r.action !== "block");
  if (firstLooser) return firstLooser.priority;
  return (rules.at(-1)?.priority ?? 0) + 1;
};

/** Open a slot at `priority`, shifting the rest of that set down by one. */
const shiftDown = async (
  tx: Tx,
  base: PolicyScopeBase,
  where: { status: string; generation?: number },
  priority: number,
) => {
  await tx.policyRuleV2.updateMany({
    where: { ...base, ...where, isDefault: false, priority: { gte: priority } },
    data: { priority: { increment: 1 } },
  });
};

const createBlockRule = async (
  tx: Tx,
  base: PolicyScopeBase,
  where: { status: string; generation?: number },
  rule: { logicalId: string; name: string; hostPattern: string },
) => {
  const priority = await insertPriority(tx, base, where);
  await shiftDown(tx, base, where, priority);
  return tx.policyRuleV2.create({
    data: {
      ...base,
      status: where.status,
      generation: where.generation ?? 0,
      priority,
      isDefault: false,
      enabled: true,
      source: BLOCKLIST_SOURCE,
      logicalId: rule.logicalId,
      name: rule.name,
      action: "block",
      requireApproval: false,
      targets: {
        create: [
          {
            kind: "network",
            hostPattern: rule.hostPattern,
            pathPattern: ANY_PATH,
            method: null,
          },
        ],
      },
    },
    select: { id: true },
  });
};

/** The scope's blocklist rules in the DRAFT set — the working copy the console
 * shows, and the set a publish carries forward. */
const listDraftRules = async (base: PolicyScopeBase) =>
  db.policyRuleV2.findMany({
    where: { ...base, status: "draft", source: BLOCKLIST_SOURCE },
    select: {
      id: true,
      logicalId: true,
      name: true,
      enabled: true,
      targets: { select: { hostPattern: true } },
    },
  });

/** The scope this caller OWNS — where its writes land. A project caller carries
 * its organizationId too (for the inherited read below), so this can't use
 * `policyScope`, which resolves an org id first. */
const ownScope = (scope: ResourceScope): PolicyScopeBase =>
  scope.projectId
    ? { scope: "project" as const, projectId: scope.projectId }
    : policyScope(scope);

/** The org scope a PROJECT caller also sees, read-only: an org-level block
 * applies to every project under it, and the panel shows it locked. Null at org
 * scope (nothing above it) — mirrors the old `scopeWhere` OR. */
const inheritedScope = (scope: ResourceScope): PolicyScopeBase | null =>
  scope.projectId && scope.organizationId
    ? { scope: "organization" as const, organizationId: scope.organizationId }
    : null;

const hostPatternOf = (rule: {
  targets: { hostPattern: string | null }[];
}): string | null => rule.targets[0]?.hostPattern ?? null;

/**
 * Seed an app's declared blocks on connect. Idempotent — a host that already has
 * a rule (enabled or not) is left exactly as the user left it.
 */
export const initBlocklistDefaults = async (
  scope: ResourceScope,
  _provider: string,
  hosts: BlocklistHost[],
): Promise<void> => {
  if (hosts.length === 0) return;
  const base = ownScope(scope);
  const existing = await listDraftRules(base);
  const covered = new Set(existing.map(hostPatternOf).filter(Boolean));
  const missing = hosts.filter((h) => !covered.has(h.hostPattern));
  if (missing.length === 0) return;

  await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    const generation = await liveGeneration(tx, base);
    for (const host of missing) {
      const rule = {
        logicalId: randomUUID(),
        name: `Block ${host.name}`,
        hostPattern: host.hostPattern,
      };
      await createBlockRule(tx, base, { status: "draft" }, rule);
      if (generation !== null) {
        await createBlockRule(
          tx,
          base,
          { status: "published", generation },
          rule,
        );
      }
    }
  });
};

export const getBlocklistState = async (
  scope: ResourceScope,
  _provider: string,
  hosts: BlocklistHost[],
): Promise<BlocklistHostState[]> => {
  const base = ownScope(scope);
  const inherited = inheritedScope(scope);
  const byHost = new Map<
    string,
    { id: string; enabled: boolean; scope: "organization" | "project" }
  >();
  // Own rules first, then the inherited org ones — an org-level block OVERRIDES
  // the project's view of that host, because the project can't lift it.
  for (const [from, rules] of [
    [base, await listDraftRules(base)] as const,
    ...(inherited
      ? ([[inherited, await listDraftRules(inherited)] as const] as const)
      : []),
  ]) {
    for (const r of rules) {
      const host = hostPatternOf(r);
      if (host)
        byHost.set(host, { id: r.id, enabled: r.enabled, scope: from.scope });
    }
  }

  return hosts.map((host) => {
    const rule = byHost.get(host.hostPattern);
    return {
      hostId: host.id,
      ruleId: rule?.id ?? null,
      enabled: rule?.enabled ?? false,
      // Blocking an arbitrary host is a policy rule now, so every entry the app
      // page shows is one the app itself declares.
      custom: false,
      name: host.name,
      hostPattern: host.hostPattern,
      scope: rule?.scope ?? null,
    };
  });
};

/** Resolve a draft blocklist rule the caller named, fenced to its own scope. */
const requireDraftRule = async (base: PolicyScopeBase, ruleId: string) => {
  const rule = await db.policyRuleV2.findFirst({
    where: { id: ruleId, ...base, status: "draft", source: BLOCKLIST_SOURCE },
    select: { id: true, logicalId: true },
  });
  if (!rule) throw new ServiceError("NOT_FOUND", "Blocklist rule not found");
  return rule;
};

export const toggleBlocklistRule = async (
  scope: ResourceScope,
  ruleId: string,
  enabled: boolean,
): Promise<void> => {
  // Writes stay in the caller's OWN scope: a project can't toggle an org-level
  // block (the panel renders those locked), and `requireDraftRule` 404s it.
  const base = ownScope(scope);
  const rule = await requireDraftRule(base, ruleId);
  await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    const generation = await liveGeneration(tx, base);
    await tx.policyRuleV2.updateMany({
      where: {
        ...base,
        logicalId: rule.logicalId,
        ...(generation === null
          ? { status: "draft" }
          : {
              OR: [{ status: "draft" }, { status: "published", generation }],
            }),
      },
      data: { enabled },
    });
  });
};

export const activateBlocklistHost = async (
  scope: ResourceScope,
  provider: string,
  hostId: string,
  hosts: BlocklistHost[],
): Promise<BlocklistHostState> => {
  const host = hosts.find((h) => h.id === hostId);
  if (!host) throw new ServiceError("BAD_REQUEST", "Unknown blocklist host ID");
  const base = ownScope(scope);

  const existing = (await listDraftRules(base)).find(
    (r) => hostPatternOf(r) === host.hostPattern,
  );
  if (existing) {
    if (!existing.enabled) {
      await toggleBlocklistRule(scope, existing.id, true);
    }
    return {
      hostId,
      ruleId: existing.id,
      enabled: true,
      custom: false,
      name: host.name,
      hostPattern: host.hostPattern,
      scope: base.scope,
    };
  }

  await initBlocklistDefaults(scope, provider, [host]);
  const created = (await listDraftRules(base)).find(
    (r) => hostPatternOf(r) === host.hostPattern,
  );
  return {
    hostId,
    ruleId: created?.id ?? null,
    enabled: true,
    custom: false,
    name: host.name,
    hostPattern: host.hostPattern,
    scope: base.scope,
  };
};

/** Delete a blocklist rule from the draft AND the live published generation. */
const deleteByLogicalIds = async (
  base: PolicyScopeBase,
  logicalIds: string[],
) => {
  if (logicalIds.length === 0) return;
  await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    const generation = await liveGeneration(tx, base);
    // Identities/targets cascade on the rule FK.
    await tx.policyRuleV2.deleteMany({
      where: {
        ...base,
        source: BLOCKLIST_SOURCE,
        logicalId: { in: logicalIds },
        ...(generation === null
          ? { status: "draft" }
          : {
              OR: [{ status: "draft" }, { status: "published", generation }],
            }),
      },
    });
  });
};

export const removeBlocklistRule = async (
  scope: ResourceScope,
  ruleId: string,
): Promise<void> => {
  const base = ownScope(scope);
  const rule = await requireDraftRule(base, ruleId);
  await deleteByLogicalIds(base, [rule.logicalId]);
};

/** Clear an app's declared blocks — used when the app is disconnected. Hosts the
 * app doesn't declare are ordinary policy rules and are never touched here. */
export const removeAllBlocklistRules = async (
  scope: ResourceScope,
  _provider: string,
  hosts: BlocklistHost[] = [],
): Promise<void> => {
  if (hosts.length === 0) return;
  const base = ownScope(scope);
  const patterns = new Set(hosts.map((h) => h.hostPattern));
  const doomed = (await listDraftRules(base))
    .filter((r) => {
      const host = hostPatternOf(r);
      return host !== null && patterns.has(host);
    })
    .map((r) => r.logicalId);
  await deleteByLogicalIds(base, doomed);
};
