import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { isSessionPolicy } from "../../validations/policy";
import { getAppPermissionDefinition } from "../../apps/app-permissions";
import { invalidateGatewayCacheForAccount } from "../../lib/gateway-invalidate";
import {
  ensureDefault,
  lockScope,
  RULE_INCLUDE,
  snapshotDraftRules,
  type PolicyRuleRow,
  type PolicyScopeBase,
} from "../policy-service";
import {
  compileConnectionStack,
  compileSecretGrant,
  conditionsCreateInput,
  GRANT_SOURCE,
  stackEquals,
  type CompiledRule,
} from "../grants-compile";
import { computeEffectiveGroups } from "../policy-reflect/effective-tools";
import {
  buildInjectionProbe,
  grantedSecretSelection,
  injectionIdentityMatches,
} from "../policy-reflect/injection";
import {
  loadInjectionRules,
  loadRulesForSimulation,
  type SimRuleRow,
} from "../policy-simulate/load-rules";
import {
  resolvePrincipalSet,
  type PrincipalSet,
} from "../policy-simulate/principal-set";
import { loadConnectionProviders } from "../policy-simulate/connection-providers";
import { loadSecretHosts } from "../policy-simulate/secret-hosts";
import { toSimRule } from "../policy-simulate/sim-rule";
import type { ConnectionGrantInput } from "../../validations/grants";

/**
 * The step-5 one-shot conversion (plans/project-attach-model.md): flip every
 * all-mode agent to `secretMode="selective"` by first materializing its
 * effective credential pool as step-2 grant stacks, fold the project's
 * pre-attach rules into those stacks, and leave the project scope holding
 * ONLY grant rows + the default — exactly what the attach UI renders.
 *
 * Runs on every web boot from BOTH policy-migrate seams (after the OSS legacy
 * pass, whose freshly minted equipment rows this normalizes in the same boot).
 * Idempotency is PER AGENT — the predicate is `secretMode === "all"` — so a
 * failed project stays visible to every later boot instead of being skipped
 * forever (the step-10 `skipAlreadyPublished` lesson).
 *
 * Safety frame, in order:
 *  - ALL-OR-NOTHING PER PROJECT: shared custom rules with empty identities
 *    apply to every agent, so deleting them while one agent's compile failed
 *    would loosen policy for that still-all-mode agent. Any failure aborts the
 *    whole project transaction; the per-project catch counts it and the next
 *    boot retries.
 *  - VERIFY THEN FLIP: the flip to selective happens only after pinned reads
 *    of the just-published generation prove the stacks landed byte-equal. The
 *    unflipped interim (stacks live, pool still all-mode) is decision-safe.
 *  - The PARTNER tier is deliberately absent: grants cannot name it, and the
 *    gateway injects it mode-independently (the step-5 gateway PR).
 *
 * TEMPORARY — delete once every environment (cloud, onprem, OSS grace window)
 * has zero all-mode agents; `README.md` in this directory is the checklist.
 */

export interface GrantConversionResult {
  projectsConverted: number;
  projectsSkipped: number;
  projectsFailed: number;
  agentsFlipped: number;
  stacksWritten: number;
  secretGrantsWritten: number;
  rulesDeleted: {
    network: number;
    behavioral: number;
    equipment: number;
    custom: number;
  };
  rateLimitsDropped: number;
  sessionPoliciesCarried: number;
  defaultsReset: number;
  preempted: number;
  verifyFailed: number;
}

export const emptyGrantConversionResult = (): GrantConversionResult => ({
  projectsConverted: 0,
  projectsSkipped: 0,
  projectsFailed: 0,
  agentsFlipped: 0,
  stacksWritten: 0,
  secretGrantsWritten: 0,
  rulesDeleted: { network: 0, behavioral: 0, equipment: 0, custom: 0 },
  rateLimitsDropped: 0,
  sessionPoliciesCarried: 0,
  defaultsReset: 0,
  preempted: 0,
  verifyFailed: 0,
});

/** One desired grant stack, carried from compile through verify to the flip. */
interface DesiredStack {
  agentId: string;
  kind: "connection" | "secret";
  targetId: string;
  desired: CompiledRule[];
}

interface ProjectRef {
  id: string;
  organizationId: string;
}

const projectBase = (projectId: string): PolicyScopeBase => ({
  scope: "project",
  projectId,
});

/**
 * Everything the conversion folds away: non-default, non-grant, non-blocklist
 * draft rows — custom + equipment (+ any legacy `app_permission` leftover).
 * Blocklist rows persist and keep evaluating on their own (the fold excludes
 * them too, or their meaning would be duplicated into stacks); the default is
 * reset in place, never deleted.
 */
const foldableWhere = (
  base: PolicyScopeBase,
): Prisma.PolicyRuleV2WhereInput => ({
  ...base,
  status: "draft",
  isDefault: false,
  source: { notIn: [GRANT_SOURCE, "blocklist", "default"] },
});

const isBehavioral = (conditions: Prisma.JsonValue | null): boolean =>
  Array.isArray(conditions) && conditions.length > 0;

const hasNetworkTarget = (row: { targets: { kind: string }[] }): boolean =>
  row.targets.some((t) => t.kind === "network");

/**
 * What the fold must NOT see: rows whose meaning is deliberately dropped
 * (census-recorded — network targets' per-host granularity has no grant
 * vocabulary; behavioral conditions are unsimulatable), and blocklist rows,
 * which PERSIST and keep evaluating on their own — folding them too would
 * duplicate their meaning into the stacks. Everything else feeds the fold, so
 * its meaning lives on.
 */
const excludedFromFold = (row: SimRuleRow): boolean =>
  isBehavioral(row.conditions) ||
  hasNetworkTarget(row) ||
  row.source === "blocklist";

/** Classify a doomed row for the counters (precedence: source, then shape). */
const classifyDoomed = (
  rows: PolicyRuleRow[],
  result: GrantConversionResult,
): void => {
  for (const row of rows) {
    if (row.source === "equipment") result.rulesDeleted.equipment += 1;
    else if (isBehavioral(row.conditions)) result.rulesDeleted.behavioral += 1;
    else if (hasNetworkTarget(row)) result.rulesDeleted.network += 1;
    else result.rulesDeleted.custom += 1;
    if (row.rateLimit !== null && row.action === "allow")
      result.rateLimitsDropped += 1;
  }
};

/**
 * The session policy a connection's grant must carry for this agent: the LAST
 * (highest-priority-number) matching allow rule with object conditions — the
 * gateway's session-policy assembly is last-match-wins per matching allow row
 * (`inject_select`), so this mirrors what it enforced pre-conversion. Walks the
 * INJECTION row set (equipment rows carry most real session policies).
 */
const sessionPolicyFor = (
  injectionRows: SimRuleRow[],
  connectionId: string,
  agentId: string,
  principals: PrincipalSet,
): Prisma.JsonValue | null => {
  let policy: Prisma.JsonValue | null = null;
  for (const row of injectionRows) {
    if (row.isDefault || row.action !== "allow") continue;
    if (!isSessionPolicy(row.conditions)) continue;
    if (!injectionIdentityMatches(row.identities, agentId, principals))
      continue;
    if (
      !row.targets.some(
        (t) => t.kind === "connection" && t.appConnectionId === connectionId,
      )
    )
      continue;
    policy = row.conditions;
  }
  return policy;
};

/**
 * Which pooled connections a SELECTIVE agent receives today from rows the
 * conversion deletes (equipment + custom injection vehicles — grant rows are
 * already canonical and stay). Mirrors the gateway's `inject_select`: allow
 * rules with a matching explicit identity, via a specific connection target or
 * an app-level `connectionScope` expansion (literal scope compare, exactly as
 * the gateway's selective arm matches).
 */
const injectedConnectionIdsFor = (
  injectionRows: SimRuleRow[],
  agentId: string,
  principals: PrincipalSet,
  poolConnections: PoolConnection[],
): Set<string> => {
  const ids = new Set<string>();
  for (const row of injectionRows) {
    if (row.isDefault || row.action !== "allow") continue;
    if (row.source === GRANT_SOURCE) continue;
    if (!injectionIdentityMatches(row.identities, agentId, principals))
      continue;
    for (const t of row.targets) {
      if (t.kind === "connection" && t.appConnectionId) {
        ids.add(t.appConnectionId);
      } else if (
        t.kind === "app" &&
        t.appProvider &&
        (t.appConnectionScope === "project" ||
          t.appConnectionScope === "organization")
      ) {
        for (const c of poolConnections) {
          if (c.provider === t.appProvider && c.scope === t.appConnectionScope)
            ids.add(c.id);
        }
      }
    }
  }
  return ids;
};

/** As above for secrets, reusing the exported selection matcher. */
const injectedSecretIdsFor = (
  injectionRows: SimRuleRow[],
  agentId: string,
  principals: PrincipalSet,
  poolSecrets: PoolSecret[],
): Set<string> => {
  const nonGrantRows = injectionRows.filter((r) => r.source !== GRANT_SOURCE);
  const { ids, levels } = grantedSecretSelection(
    nonGrantRows,
    agentId,
    principals,
  );
  const set = new Set(ids);
  for (const s of poolSecrets) {
    if (levels.has(s.scope as "project" | "organization")) set.add(s.id);
  }
  // The fence is the pool: a rule naming a foreign/deleted id contributes
  // nothing (fail-closed, mirroring the gateway's fetch-side fence).
  const pooled = new Set(poolSecrets.map((s) => s.id));
  return new Set([...set].filter((id) => pooled.has(id)));
};

/**
 * Per-tool verdicts → the grant tri-state. `unmanaged` folds as allow (no
 * project opinion = the uncustomized attach); a `mixed` verdict cannot occur
 * once network/behavioral rules are excluded from the fold (remaining rules
 * treat every variant of a tool uniformly) — hitting one means an unmodeled
 * rule shape, so abort the project loudly rather than guess.
 */
export const groupsToGrantInput = (
  groups: { tools: { toolId: string; verdict: string }[] }[],
  agentId: string,
): ConnectionGrantInput => {
  const allow: string[] = [];
  const ask: string[] = [];
  let customized = false;
  for (const group of groups) {
    for (const tool of group.tools) {
      switch (tool.verdict) {
        case "allow":
        case "unmanaged":
          allow.push(tool.toolId);
          break;
        case "approval":
          ask.push(tool.toolId);
          customized = true;
          break;
        case "block":
          customized = true;
          break;
        default:
          throw new Error(
            `tool ${tool.toolId} folds to "${tool.verdict}" for agent ${agentId} — unconvertible`,
          );
      }
    }
  }
  return customized ? { access: "custom", allow, ask } : { access: "full" };
};

interface PoolSecret {
  id: string;
  name: string;
  scope: string;
  hostPattern: string;
}

interface PoolConnection {
  id: string;
  provider: string;
  label: string | null;
  scope: string | null;
}

/** The (agent, target) partition key of a stack's rows. */
const pairKey = (agentId: string, kind: string, targetId: string): string =>
  `${agentId}\n${kind}\n${targetId}`;

const stackRowsFor = (
  rows: PolicyRuleRow[],
  stack: DesiredStack,
): PolicyRuleRow[] =>
  rows
    .filter(
      (r) =>
        r.source === GRANT_SOURCE &&
        r.identities.some((i) => i.agentId === stack.agentId) &&
        r.targets.some((t) =>
          stack.kind === "connection"
            ? t.appConnectionId === stack.targetId
            : t.secretId === stack.targetId,
        ),
    )
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

/**
 * Convert one project. Exported for `migrate-import`, which must run it for a
 * freshly imported project AFTER its own transaction commits (this opens its
 * own transaction + advisory lock — nesting would deadlock).
 */
export const convertProject = async (
  project: ProjectRef,
  result: GrantConversionResult,
): Promise<void> => {
  const base = projectBase(project.id);

  // Fast path (no tx): the common every-boot-after-the-first case.
  const [allModeCount, foldableCount, blockDefaultCount] = await Promise.all([
    db.agent.count({
      where: { projectId: project.id, secretMode: { not: "selective" } },
    }),
    db.policyRuleV2.count({ where: foldableWhere(base) }),
    db.policyRuleV2.count({
      where: { ...base, status: "draft", isDefault: true, action: "block" },
    }),
  ]);
  if (allModeCount === 0 && foldableCount === 0 && blockDefaultCount === 0) {
    result.projectsSkipped += 1;
    return;
  }

  const outcome = await db.$transaction(
    async (tx) => {
      await lockScope(tx, base);

      // Re-check under the lock: a concurrent replica may have just finished.
      const [agents, lockedFoldable] = await Promise.all([
        tx.agent.findMany({
          where: { projectId: project.id },
          select: { id: true, name: true, secretMode: true },
        }),
        tx.policyRuleV2.count({ where: foldableWhere(base) }),
      ]);
      const lockedBlockDefault = await tx.policyRuleV2.count({
        where: { ...base, status: "draft", isDefault: true, action: "block" },
      });
      const allMode = agents.filter((a) => a.secretMode !== "selective");
      if (
        allMode.length === 0 &&
        lockedFoldable === 0 &&
        lockedBlockDefault === 0
      ) {
        return { skipped: true } as const;
      }

      // ── Load the fold inputs. These loaders are db-bound (not tx-bound),
      // which is safe by the locking protocol: every rule writer serializes on
      // `lockScope`, so no concurrent rule write can commit while we hold it —
      // and none of OUR writes have happened yet. Membership/pool reads have no
      // lock and need none (any consistent snapshot is valid input).
      const [
        decisionRows,
        injectionRows,
        principals,
        secretHosts,
        connectionProviders,
        poolSecrets,
        poolConnections,
      ] = await Promise.all([
        loadRulesForSimulation(base, "draft"),
        loadInjectionRules(base, "draft"),
        resolvePrincipalSet(project.id, project.organizationId),
        loadSecretHosts(project.organizationId, project.id),
        loadConnectionProviders(project.organizationId, project.id),
        // The gateway's secret fences, verbatim: project arm has NO scope
        // filter; org arm requires scope='organization'. Partner-scoped rows
        // carry neither id and stay out by construction.
        db.secret.findMany({
          where: {
            OR: [
              { projectId: project.id },
              {
                organizationId: project.organizationId,
                scope: "organization",
              },
            ],
          },
          select: { id: true, name: true, scope: true, hostPattern: true },
        }),
        db.appConnection.findMany({
          where: {
            status: "connected",
            OR: [
              { projectId: project.id },
              {
                organizationId: project.organizationId,
                scope: "organization",
              },
            ],
          },
          select: { id: true, provider: true, label: true, scope: true },
        }),
      ]);

      // The fold sees the project layer AS IT WILL REMAIN minus grants: the
      // deleted-for-good rules (network, behavioral) are excluded — their
      // meaning is the census-recorded loosening — and blocklist rows are
      // excluded because they PERSIST and keep evaluating on their own.
      const foldRows = decisionRows.filter((r) => !excludedFromFold(r));
      const simRules = foldRows.map((r) =>
        toSimRule(r, secretHosts, connectionProviders),
      );
      const engineRules = simRules.map((s) => s.rule);

      const poolSecretHostPatterns = poolSecrets.map((s) => s.hostPattern);
      const poolProviders = [
        ...new Set(poolConnections.map((c) => c.provider)),
      ];

      // ── Compile the desired stacks.
      const stacks: DesiredStack[] = [];
      const flipAgentIds: string[] = [];
      let sessionPoliciesCarried = 0;

      for (const agent of agents) {
        const isAllMode = agent.secretMode !== "selective";
        const probe = buildInjectionProbe({
          agent: { id: agent.id },
          // All-mode: the whole fenced pool (the probe also folds the agent's
          // rule grants — a subset of the pool, so the union is unchanged).
          // Selective: nothing here — the folded grants are the whole story.
          poolSecretHostPatterns: isAllMode ? poolSecretHostPatterns : [],
          poolProviders: isAllMode ? poolProviders : [],
          rules: injectionRows,
          principals,
          secretHosts,
          connectionProviders,
        });

        // Which credentials this agent's stacks must cover: the whole pool for
        // all-mode; for selective, exactly what its doomed (equipment/custom)
        // rows inject today — grant-fed pairs are already canonical and stay.
        // Both sets are pool-fenced, so a vehicle naming a DISCONNECTED
        // connection maps to nothing and its rule is deleted with the fold —
        // a would-be re-connect no longer revives it (known, recorded: the
        // census found zero non-connected connections in dev or prod).
        const injectedConnections = isAllMode
          ? null
          : injectedConnectionIdsFor(
              injectionRows,
              agent.id,
              principals,
              poolConnections,
            );
        const injectedSecrets = isAllMode
          ? null
          : injectedSecretIdsFor(
              injectionRows,
              agent.id,
              principals,
              poolSecrets,
            );
        const connections = injectedConnections
          ? poolConnections.filter((c) => injectedConnections.has(c.id))
          : poolConnections;
        const secrets = injectedSecrets
          ? poolSecrets.filter((s) => injectedSecrets.has(s.id))
          : poolSecrets;

        for (const connection of connections) {
          const def = getAppPermissionDefinition(connection.provider);
          // Catalog-less providers have no per-tool vocabulary to fold — the
          // uncustomized whole-app attach is the only expressible shape.
          const input: ConnectionGrantInput = def
            ? groupsToGrantInput(
                computeEffectiveGroups({
                  def,
                  simRules,
                  engineRules,
                  agentId: agent.id,
                  principals,
                  probe,
                  viewerSeesOrgRules: true,
                  winningConnectionId: connection.id,
                }).groups,
                agent.id,
              )
            : { access: "full" };
          const conditions = sessionPolicyFor(
            injectionRows,
            connection.id,
            agent.id,
            principals,
          );
          const nameBase = `Grant: ${agent.name} · ${connection.label ?? connection.provider}`;
          const desired = compileConnectionStack(
            nameBase,
            connection.provider,
            input,
            conditions,
          );
          // Count only policies that actually LANDED: an all-blocked stack has
          // no allow row to carry one — and pre-conversion that restriction
          // restricted an injection whose every request was blocked anyway.
          if (desired.some((r) => r.action === "allow" && r.conditions != null))
            sessionPoliciesCarried += 1;
          stacks.push({
            agentId: agent.id,
            kind: "connection",
            targetId: connection.id,
            desired,
          });
        }
        for (const secret of secrets) {
          stacks.push({
            agentId: agent.id,
            kind: "secret",
            targetId: secret.id,
            desired: compileSecretGrant(
              `Grant: ${agent.name} · ${secret.name}`,
            ),
          });
        }
        if (isAllMode) flipAgentIds.push(agent.id);
      }

      // ── Delete: the foldable rows (meaning now in the stacks or censused)
      // plus the rewritten pairs' existing grant rows (delete-then-recompile).
      const doomedFoldable = await tx.policyRuleV2.findMany({
        where: foldableWhere(base),
        include: RULE_INCLUDE,
      });
      const draftGrantRows = await tx.policyRuleV2.findMany({
        where: { ...base, status: "draft", source: GRANT_SOURCE },
        include: RULE_INCLUDE,
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });
      const rewrittenPairs = new Set(
        stacks.map((s) => pairKey(s.agentId, s.kind, s.targetId)),
      );
      const doomedGrantIds = draftGrantRows
        .filter((row) => {
          const agentId = row.identities[0]?.agentId;
          if (!agentId) return false;
          const target = row.targets[0];
          const key = target?.appConnectionId
            ? pairKey(agentId, "connection", target.appConnectionId)
            : target?.secretId
              ? pairKey(agentId, "secret", target.secretId)
              : null;
          return key !== null && rewrittenPairs.has(key);
        })
        .map((r) => r.id);

      await tx.policyRuleV2.deleteMany({
        where: {
          id: { in: [...doomedFoldable.map((r) => r.id), ...doomedGrantIds] },
        },
      });

      // ── Default: reset a Block posture (its catalog meaning is now explicit
      // stack rows; non-catalog surfaces are the recorded change), then make
      // sure one exists (the 95% publish-from-nothing path).
      let defaultsReset = 0;
      const blockDefault = await tx.policyRuleV2.findFirst({
        where: { ...base, status: "draft", isDefault: true, action: "block" },
        select: { id: true },
      });
      if (blockDefault) {
        await tx.policyRuleV2.update({
          where: { id: blockDefault.id },
          data: { action: "allow" },
        });
        defaultsReset = 1;
      }
      await ensureDefault(tx, base);

      // ── Write the stacks at the tail priority band, then publish ONCE.
      const tail = await tx.policyRuleV2.aggregate({
        where: { ...base, status: "draft", isDefault: false },
        _max: { priority: true },
      });
      let priority = (tail._max.priority ?? 0) + 1;
      for (const stack of stacks) {
        for (const rule of stack.desired) {
          await tx.policyRuleV2.create({
            data: {
              ...base,
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
              createdByUserId: null,
              identities: {
                create: [{ agent: { connect: { id: stack.agentId } } }],
              },
              targets: {
                create: [
                  stack.kind === "connection"
                    ? {
                        kind: "connection",
                        appConnection: { connect: { id: stack.targetId } },
                        appTools: rule.tools,
                      }
                    : {
                        kind: "secret",
                        secret: { connect: { id: stack.targetId } },
                      },
                ],
              },
            },
            select: { id: true },
          });
        }
      }

      const draftRules = await tx.policyRuleV2.findMany({
        where: { ...base, status: "draft" },
        include: RULE_INCLUDE,
        orderBy: [{ priority: "asc" }, { id: "asc" }],
      });
      const { generation } = await snapshotDraftRules(
        tx,
        base,
        draftRules,
        null,
      );

      return {
        skipped: false,
        generation,
        stacks,
        flipAgentIds,
        doomedFoldable,
        defaultsReset,
        sessionPoliciesCarried,
      } as const;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  if (outcome.skipped) {
    result.projectsSkipped += 1;
    return;
  }

  // ── Verify against the WRITTEN generation, then — and only then — flip.
  const maxGen = await db.policyRuleV2.aggregate({
    where: { ...base, status: "published" },
    _max: { generation: true },
  });
  if ((maxGen._max.generation ?? 0) > outcome.generation) {
    // A concurrent replica re-published after us; its own verify/flip pass
    // owns the outcome. Idempotent either way — unflipped agents reconvert.
    result.preempted += 1;
    console.error(
      `[grant-conversion] PREEMPTED project=${project.id}: generation ${String(outcome.generation)} superseded before verification — leaving the flip to the newer run.`,
    );
    return;
  }

  const published = await db.policyRuleV2.findMany({
    where: { ...base, status: "published", generation: outcome.generation },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  const strayPublished = published.filter(
    (r) =>
      !r.isDefault &&
      r.source !== GRANT_SOURCE &&
      r.source !== "blocklist" &&
      r.source !== "default",
  );
  const publishedDefault = published.find((r) => r.isDefault);
  const stacksVerified = outcome.stacks.every((stack) =>
    stackEquals(stackRowsFor(published, stack), stack.desired),
  );
  const verified =
    stacksVerified &&
    strayPublished.length === 0 &&
    publishedDefault?.action === "allow";

  if (!verified) {
    result.verifyFailed += 1;
    console.error(
      `[grant-conversion] VERIFY FAILED project=${project.id} generation=${String(outcome.generation)} (stacks=${String(stacksVerified)}, strays=${String(strayPublished.length)}, default=${publishedDefault?.action ?? "missing"}): agents stay all-mode (pool-governed, safe) and the next boot reconverts. The generation is KEPT — it is what is enforcing.`,
    );
    return;
  }

  if (outcome.flipAgentIds.length > 0) {
    await db.agent.updateMany({
      where: { id: { in: outcome.flipAgentIds } },
      data: { secretMode: "selective" },
    });
    result.agentsFlipped += outcome.flipAgentIds.length;
    // Best-effort: the gateway's 60s connect-cache TTL is the backstop.
    invalidateGatewayCacheForAccount(project.id);
  }

  result.projectsConverted += 1;
  result.stacksWritten += outcome.stacks.filter(
    (s) => s.kind === "connection",
  ).length;
  result.secretGrantsWritten += outcome.stacks.filter(
    (s) => s.kind === "secret",
  ).length;
  classifyDoomed(outcome.doomedFoldable, result);
  result.defaultsReset += outcome.defaultsReset;
  result.sessionPoliciesCarried += outcome.sessionPoliciesCarried;
};

/**
 * The boot pass: every project, sequentially (this is boot-time work — a
 * per-project transaction keeps the lock windows short; parallelism would just
 * contend on the database).
 */
export const runGrantConversion = async (): Promise<GrantConversionResult> => {
  const result = emptyGrantConversionResult();
  const projects = await db.project.findMany({
    select: { id: true, organizationId: true },
  });
  for (const project of projects) {
    try {
      await convertProject(project, result);
    } catch (err) {
      result.projectsFailed += 1;
      console.error(
        `[grant-conversion] project=${project.id} FAILED and was left fully unconverted (all-or-nothing; the next boot retries):`,
        err,
      );
    }
  }
  const summary =
    `[grant-conversion] projects: ${String(result.projectsConverted)} converted, ` +
    `${String(result.projectsSkipped)} skipped, ${String(result.projectsFailed)} failed, ` +
    `${String(result.preempted)} preempted, ${String(result.verifyFailed)} verify-failed; ` +
    `agents flipped: ${String(result.agentsFlipped)}; ` +
    `stacks: ${String(result.stacksWritten)} connection + ${String(result.secretGrantsWritten)} secret; ` +
    `deleted: ${String(result.rulesDeleted.network)} network, ${String(result.rulesDeleted.behavioral)} behavioral, ` +
    `${String(result.rulesDeleted.equipment)} equipment, ${String(result.rulesDeleted.custom)} custom ` +
    `(${String(result.rateLimitsDropped)} rate limits dropped); ` +
    `session policies carried: ${String(result.sessionPoliciesCarried)}; defaults reset: ${String(result.defaultsReset)}`;
  if (result.projectsFailed > 0 || result.verifyFailed > 0)
    console.error(summary);
  else console.log(summary);
  return result;
};
