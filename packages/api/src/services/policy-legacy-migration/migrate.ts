/**
 * The one-shot legacy → v2 policy migration — see ./README.md.
 *
 * Runs on every OSS web-server boot (after the entrypoint's `prisma migrate
 * deploy`) and converts any project that still carries old-model policy but
 * never materialized v2: its custom rules, app-permission rows, enabled
 * blocklist, per-agent credential grants, and the org row's `policyMode`
 * become ONE published `policy_rules_v2` generation. The published generation
 * is the gateway's per-project enforce signal, so convert → verify → enforce is
 * structural.
 *
 * Idempotent: a project that already has a published generation is skipped, so
 * this is a no-op on every boot after the first. Best-effort: a failure is
 * logged and never crashes the web server, and the old rows are retained, so a
 * failed run is fully recoverable by fixing the cause and rebooting.
 *
 * OSS ONLY. Cloud was converted in 2026-07 and its seam
 * (`apps/web/src/ee/policy-migrate.ts`) never imports this; onprem is covered
 * by the boot guard, which reports rather than converts.
 */
import { db } from "@onecli/db";
import {
  backfillPublishScope,
  type BackfillRuleInput,
} from "../policy-service";
import {
  OSS_MIGRATED_DEFAULT_DESCRIPTION,
  ossCanonRule,
  ossProjectDefaultRule,
  translateOssEquipment,
  translateOssProjectRules,
  type OssOldRule,
} from "./translate";
import {
  OSS_OLD_RULE_SELECT,
  readOssEquipment,
  reconstructOssRule,
} from "./read-legacy";

export interface OssCutoverResult {
  /** `diverged` still leaves a generation published and enforcing — see the
   * divergence branch. A thrown error is counted by the caller, not returned. */
  status: "cut" | "skipped" | "diverged";
  ruleCount: number;
  /** Set on a skip when a USER publish pre-empted the conversion: the project
   * has legacy rules but its active generation was not written here (its
   * Default Rule lacks the migration marker), so those rules were never
   * translated and the skip-if-published idempotency will never retry.
   * Loudly logged. The remedy is to re-author the policy in the console —
   * NOT to delete the project's v2 rows, which since step 10 would leave it
   * enforcing nothing until the next boot completes. */
  preempted?: boolean;
}

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
  // Pinned to the generation THIS run wrote: a concurrent replica can
  // legitimately publish a newer one in the commit→verify window, and an
  // unpinned read would false-diverge a perfectly healthy project.
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

/** A project that already has a published generation needs no conversion — but
 * it may have been published by a USER before the migration ran (a raced boot
 * walk), in which case its legacy rules were never translated and the plain
 * idempotency skip would hide that forever. Detected via the migration marker on
 * the active generation's Default Rule. Two cheap counts, no translation. */
const skipAlreadyPublished = async (
  projectId: string,
): Promise<OssCutoverResult> => {
  const legacyCount = await db.policyRule.count({ where: { projectId } });
  if (legacyCount === 0) return { status: "skipped", ruleCount: 0 };
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
  if (activeDefault?.description === OSS_MIGRATED_DEFAULT_DESCRIPTION) {
    return { status: "skipped", ruleCount: 0 };
  }
  // Do NOT advise deleting the v2 rows to force a re-run: since step 10 there is
  // no legacy engine behind them, so a project with no published generation
  // enforces NOTHING until the next boot completes.
  console.error(
    `[policy-legacy-migration] PREEMPTED project=${projectId}: this project's v2 policy was published before the migration ran, so ${legacyCount} legacy rule(s) were NOT carried over. They are still readable in \`policy_rules\` — re-author them in the Policy console. Do not delete the project's policy_rules_v2 rows: nothing would be enforced until it is republished.`,
  );
  return { status: "skipped", ruleCount: 0, preempted: true };
};

/** Cut one project over. Idempotent; the generation is kept on divergence. */
export const cutoverOssProject = async (
  projectId: string,
  policyMode: string,
): Promise<OssCutoverResult> => {
  // FAST PATH. This walks every project on EVERY boot, forever — long after the
  // last instance has converted — so decide from one count before translating
  // anything. Without it a converted instance re-reads `policy_rules` and every
  // agent's grants for each project on each boot, purely to throw the result
  // away at `backfillPublishScope`'s idempotency check.
  const published = await db.policyRuleV2.count({
    where: { scope: "project", projectId, status: "published" },
  });
  if (published > 0) return skipAlreadyPublished(projectId);

  const { rules, droppedSessionPolicies } = await buildProjectRules(
    projectId,
    policyMode,
  );
  for (const drop of droppedSessionPolicies) {
    console.warn(
      `[policy-legacy-migration] dropping stored sessionPolicy (never enforced in OSS): project=${projectId} agent=${drop.agentId} connection=${drop.appConnectionId}`,
    );
  }
  const result = await backfillPublishScope({ projectId }, rules);
  // Lost a race with a concurrent replica between the count above and the
  // scope-locked write — same question, same answer.
  if (result.skipped) return skipAlreadyPublished(projectId);
  if (await verifyProject(projectId, result.generation ?? 1, rules)) {
    return { status: "cut", ruleCount: rules.length };
  }
  // Divergence — a translator-bug-only condition, fenced by the parity proofs.
  //
  // This used to compensate by DELETING the project's v2 rows, because before
  // step 10 "no published generation" meant the gateway fell back to the legacy
  // engine and the project kept enforcing its old rules. That fallback is gone:
  // an empty rule set now decides Allow, so deleting would turn a policy that
  // merely failed to round-trip into no policy at all — allow-everything, for a
  // security product, on a translator nit.
  //
  // The written generation is KEPT. It enforces the translation we produced,
  // which is the closest thing to the operator's intent that exists, and the
  // legacy rows are retained so the divergence can be diagnosed and the policy
  // republished by hand.
  console.error(
    `[policy-legacy-migration] DIVERGENCE project=${projectId} — the published v2 generation does not match the translation. It is being KEPT and IS enforcing (deleting it would enforce nothing at all). Compare it against the project's \`policy_rules\` rows and republish from the Policy console if it is wrong.`,
  );
  return { status: "diverged", ruleCount: rules.length };
};

/**
 * The full boot pass: every org (createdAt asc) → every project (createdAt asc)
 * → convert, with per-project failure isolation so one bad project cannot stop
 * the rest. There is no follow-up sweep: the old model is frozen (step 10
 * deleted every writer), so a converted project cannot drift back out of date.
 */
export const runLegacyPolicyMigration = async (): Promise<void> => {
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
  // Counted separately: a preempted project is neither converted nor broken —
  // it needs a human. Folding it into `skipped` would let the summary read
  // clean while the error above says otherwise.
  let preempted = 0;
  for (const org of orgs) {
    for (const project of org.projects) {
      try {
        const result = await cutoverOssProject(project.id, org.policyMode);
        if (result.status === "cut") {
          cut += 1;
          console.log(
            `[policy-legacy-migration] cut project=${project.id} rules=${result.ruleCount}`,
          );
        } else if (result.status === "skipped") {
          if (result.preempted) preempted += 1;
          else skipped += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(
          `[policy-legacy-migration] project=${project.id} failed:`,
          err,
        );
      }
    }
  }
  // No steady-state sweep: the old model is frozen (step 10 deleted every
  // writer), so a converted project can never drift back out of date. This is a
  // one-shot conversion, not a running bridge.
  const summary = `[policy-legacy-migration] done: ${cut} converted, ${skipped} already converted, ${failed} failed${preempted > 0 ? `, ${preempted} PREEMPTED (see the errors above — their legacy rules were not carried over)` : ""}`;
  if (failed > 0 || preempted > 0) console.error(summary);
  else console.log(summary);
};
