/**
 * The OSS release-as-cutover boot pass (step 9.5): per project, translate the
 * legacy policy state (custom rules + app-permission rows + blocklist +
 * equipment + the org-row `policyMode`) into ONE atomic published v2
 * generation — rules, equipment, and the per-project Default Rule together —
 * then verify decision-preservation. The published generation is
 * simultaneously the gateway's per-project cutover signal, so the boot order
 * backfill → verify → enforce is structural: a project enforces v2 only once
 * its generation exists and verified.
 *
 * Idempotent (the shared `backfillPublishScope` skips any project with a
 * published generation). On a verify mismatch the project's v2 rows are
 * COMPENSATING-DELETED — it stays on legacy enforcement (the gateway's
 * per-project fallback), loudly, and retries next boot. No heal-by-replace:
 * OSS has no manual flip to gate a heal behind.
 *
 * Invoked from the OSS `lib/policy-migrate` boot seam (a file every EE
 * edition aliases away); cloud/onprem run their own EE machinery instead.
 */
import { db } from "@onecli/db";
import { policyEditingEnabled } from "../lib/policy-flags";
import {
  backfillPublishScope,
  lockScope,
  policyScope,
  type BackfillRuleInput,
} from "./policy-service";
import {
  OSS_MIGRATED_DEFAULT_DESCRIPTION,
  ossCanonRule,
  ossProjectDefaultRule,
  translateOssEquipment,
  translateOssProjectRules,
  type OssOldRule,
} from "./policy-oss-translate";
import {
  OSS_OLD_RULE_SELECT,
  readOssEquipment,
  reconstructOssRule,
  rematerializeOssScope,
} from "./policy-oss-bridge";

export interface OssCutoverResult {
  status: "cut" | "skipped" | "diverged" | "failed";
  ruleCount: number;
  /** Set on a skip when a USER publish pre-empted migration: the project has
   * legacy rules but its active generation was not written by the cutover
   * (its Default Rule lacks the migration marker) — the legacy rules were
   * never translated, and the skip-if-published idempotency will never retry.
   * Loudly logged; the operator remedy is deleting the project's v2 rows and
   * rebooting (documented in the plan). */
  preempted?: boolean;
}

/**
 * The OSS new-project seeder (wired via the OSS init seam): seed a fresh
 * project's published Default Rule from the INSTANCE POSTURE — the oldest cut
 * project's published Default-Rule action (fresh install → Allow, matching
 * today's `policyMode` default) — so a deny-posture instance doesn't mint
 * allow-by-default projects, and the new project enforces v2 from birth (the
 * published generation is the gateway's cutover signal). Org-only calls no-op:
 * OSS has no org scope.
 */
export const ossNewProjectPolicySeeder = {
  seed: async (_organizationId: string, projectId?: string): Promise<void> => {
    // Rollback posture: with editing flipped off the instance is pure legacy —
    // new projects must not mint v2 generations (the gateway would start
    // enforcing them on re-flip without a verify).
    if (!policyEditingEnabled()) return;
    if (!projectId) return;
    // The instance posture: the OLDEST cut project's ACTIVE default. Two
    // steps, because a project retains several published generations (each
    // snapshot carries its own default row) — a single findFirst without a
    // generation bound would read a nondeterministic historical default.
    const oldest = await db.policyRuleV2.findFirst({
      where: { scope: "project", isDefault: true, status: "published" },
      orderBy: { project: { createdAt: "asc" } },
      select: { projectId: true },
    });
    const posture = oldest?.projectId
      ? await db.policyRuleV2.findFirst({
          where: {
            scope: "project",
            projectId: oldest.projectId,
            isDefault: true,
            status: "published",
          },
          orderBy: { generation: "desc" },
          select: { action: true },
        })
      : null;
    const defaultRule = ossProjectDefaultRule(
      posture?.action === "block" ? "deny" : "allow",
    );
    await backfillPublishScope({ projectId }, [defaultRule]);
  },
};

/** Build the project's full initial v2 set: the ordered policy rules
 * (customs + app-permission-derived + enabled blocklist), the equipment rules
 * appended after, and the Default Rule last. */
const buildProjectRules = async (
  projectId: string,
  policyMode: string,
): Promise<{
  rules: BackfillRuleInput[];
  droppedSessionPolicies: { agentId: string; appConnectionId: string }[];
}> => {
  const oldRows = await db.policyRule.findMany({
    where: { projectId },
    select: OSS_OLD_RULE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const policySet = translateOssProjectRules(oldRows as OssOldRule[]);
  const { rules: equipment, droppedSessionPolicies } = translateOssEquipment(
    await readOssEquipment(db, projectId),
  );
  equipment.forEach((r, i) => {
    r.priority = policySet.length + i;
  });
  const defaultRule = ossProjectDefaultRule(policyMode);
  defaultRule.priority = policySet.length + equipment.length;
  return {
    rules: [...policySet, ...equipment, defaultRule],
    droppedSessionPolicies,
  };
};

/** Verify the freshly-published generation preserves the translation exactly:
 * re-read in the gateway's order and compare canon-by-index (unique priorities
 * make the alignment exact). */
const verifyProject = async (
  projectId: string,
  generation: number,
  written: BackfillRuleInput[],
): Promise<boolean> => {
  // Pinned to the generation THIS cut wrote: the live coherence bridge (or a
  // sibling replica's sweep) can legitimately mint a newer generation in the
  // commit→verify window, and an unpinned read would false-diverge a healthy
  // project into a compensating delete.
  const stored = await db.policyRuleV2.findMany({
    where: { scope: "project", projectId, status: "published", generation },
    include: { identities: true, targets: true },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  if (stored.length !== written.length) return false;
  const expected = [...written].sort((a, b) => a.priority - b.priority);
  return stored.every(
    (row, i) =>
      expected[i] !== undefined &&
      ossCanonRule(reconstructOssRule(row)) === ossCanonRule(expected[i]),
  );
};

/** Cut one project over (idempotent; compensating delete on divergence). */
export const cutoverOssProject = async (
  projectId: string,
  policyMode: string,
): Promise<OssCutoverResult> => {
  const { rules, droppedSessionPolicies } = await buildProjectRules(
    projectId,
    policyMode,
  );
  for (const drop of droppedSessionPolicies) {
    console.warn(
      `[policy-oss-cutover] dropping stored sessionPolicy (never enforced in OSS): project=${projectId} agent=${drop.agentId} connection=${drop.appConnectionId}`,
    );
  }
  const result = await backfillPublishScope({ projectId }, rules);
  if (result.skipped) {
    // Already cut — unless a USER publish pre-empted migration (raced the
    // boot walk, or landed between a compensating delete and the next boot):
    // then the generation exists but the legacy rules were never translated,
    // and the idempotency skip would hide that forever. Detect via the
    // migration marker on the active generation's Default Rule.
    const legacyCount = await db.policyRule.count({ where: { projectId } });
    if (legacyCount > 0) {
      const activeDefault = await db.policyRuleV2.findFirst({
        where: {
          scope: "project",
          projectId,
          status: "published",
          isDefault: true,
        },
        orderBy: { generation: "desc" },
        select: { description: true },
      });
      if (activeDefault?.description !== OSS_MIGRATED_DEFAULT_DESCRIPTION) {
        console.error(
          `[policy-oss-cutover] PREEMPTED project=${projectId}: a user publish created the v2 generation before migration ran — ${legacyCount} legacy rule(s) were NOT migrated. To migrate, delete the project's policy_rules_v2 rows and reboot.`,
        );
        return { status: "skipped", ruleCount: 0, preempted: true };
      }
    }
    return { status: "skipped", ruleCount: 0 };
  }
  if (await verifyProject(projectId, result.generation ?? 1, rules)) {
    return { status: "cut", ruleCount: rules.length };
  }
  // Divergence: leave the project on LEGACY enforcement by removing its v2
  // rows (no published generation = the gateway's fallback signal). This is a
  // translator-bug-only condition — fenced by the private parity proofs — so
  // fail loudly and retry next boot.
  const base = policyScope({ projectId });
  await db.$transaction(async (tx) => {
    await lockScope(tx, base);
    await tx.policyRuleV2.deleteMany({ where: base });
  });
  console.error(
    `[policy-oss-cutover] DIVERGENCE project=${projectId} — v2 rows removed, project stays on legacy enforcement`,
  );
  return { status: "diverged", ruleCount: 0 };
};

/**
 * The full boot pass: every org (createdAt asc) → every project (createdAt
 * asc) → cutover (per-project failure isolation), then the bridge sweep over
 * every cut project (self-heals blocklist/equipment drift; after a fresh
 * cutover it usually no-ops on the publish-set signature — equal-rank tie
 * placements may converge through one decision-neutral extra generation).
 */
export const runOssPolicyCutover = async (): Promise<void> => {
  const orgs = await db.organization.findMany({
    select: {
      id: true,
      policyMode: true,
      projects: { select: { id: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
  let cut = 0;
  let skipped = 0;
  let failed = 0;
  for (const org of orgs) {
    for (const project of org.projects) {
      try {
        const result = await cutoverOssProject(project.id, org.policyMode);
        if (result.status === "cut") {
          cut += 1;
          console.log(
            `[policy-oss-cutover] cut project=${project.id} rules=${result.ruleCount}`,
          );
        } else if (result.status === "skipped") {
          skipped += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(
          `[policy-oss-cutover] project=${project.id} failed:`,
          err,
        );
      }
    }
  }
  // The steady-state sweep: re-derive blocklist/equipment for every cut
  // project (uncut projects self-gate inside the bridge).
  for (const org of orgs) {
    for (const project of org.projects) {
      try {
        await rematerializeOssScope({ projectId: project.id });
      } catch (err) {
        console.error(
          `[policy-oss-cutover] bridge sweep project=${project.id} failed:`,
          err,
        );
      }
    }
  }
  console.log(
    `[policy-oss-cutover] done: ${cut} cut, ${skipped} already cut, ${failed} failed`,
  );
};
