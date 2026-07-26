import { db } from "@onecli/db";
import { logger } from "../lib/logger";

/**
 * Boot safety guard (step 10) — the ASSERTION behind the conversion, not a
 * substitute for it.
 *
 * The v2 engine is the sole authority and decides Allow on an empty rule set,
 * so a scope carrying old-model rows with no materialized v2 policy silently
 * enforces nothing: its legacy blocks, rate limits and approvals stop applying.
 * This finds exactly that and logs a loud error.
 *
 * Ordering matters. On OSS this runs AFTER
 * `services/policy-legacy-migration/`, which converts such a scope — so
 * anything it reports is what the conversion did NOT cover: a project whose
 * conversion threw, or (in OSS) org-scoped legacy rows, which have no OSS
 * equivalent by the §2.9 boundary. On every EE edition it runs ALONE: cloud was
 * converted in 2026-07 and has nothing to report, and an onprem instance in
 * this state should surface it to an operator rather than have its policy
 * rewritten unattended on boot.
 *
 * NEVER migrates and NEVER throws into boot — the old tables are kept, so the
 * situation is recoverable and no data is lost.
 */
export const guardUnmigratedPolicy = async (): Promise<void> => {
  try {
    // Distinct scopes that still carry old-model rules. A scope is "migrated"
    // once it has a PUBLISHED v2 Default Rule (the gateway's per-scope enable
    // signal); any scope with legacy rows but no such default never cut over.
    const [legacyProjects, legacyOrgs] = await Promise.all([
      db.policyRule.findMany({
        where: { projectId: { not: null } },
        distinct: ["projectId"],
        select: { projectId: true },
      }),
      db.policyRule.findMany({
        where: { scope: "organization", organizationId: { not: null } },
        distinct: ["organizationId"],
        select: { organizationId: true },
      }),
    ]);
    if (legacyProjects.length === 0 && legacyOrgs.length === 0) return;

    const stranded: string[] = [];
    for (const { projectId } of legacyProjects) {
      if (!projectId) continue;
      const migrated = await db.policyRuleV2.findFirst({
        where: {
          scope: "project",
          projectId,
          isDefault: true,
          status: "published",
        },
        select: { id: true },
      });
      if (!migrated) stranded.push(`project:${projectId}`);
    }
    for (const { organizationId } of legacyOrgs) {
      if (!organizationId) continue;
      const migrated = await db.policyRuleV2.findFirst({
        where: {
          scope: "organization",
          organizationId,
          isDefault: true,
          status: "published",
        },
        select: { id: true },
      });
      if (!migrated) stranded.push(`organization:${organizationId}`);
    }
    if (stranded.length === 0) return;

    const shown = stranded.slice(0, 20).join(", ");
    logger.error(
      `[policy-migration-guard] ${stranded.length} scope(s) have legacy policy rules but no materialized v2 policy — the gateway will NOT enforce their policies (it decides allow-all on an empty rule set). On OSS the boot conversion runs immediately before this check, so these are scopes it could not cover: look for a preceding [policy-legacy-migration] error, or an organization-scoped legacy rule (OSS has no org policy). Re-author the affected policy in the Policy console. The old tables are retained, so nothing is lost. Affected: ${shown}${stranded.length > 20 ? " …" : ""}`,
    );
  } catch (err) {
    // Best-effort only — a diagnostic must never take down boot.
    logger.error({ err }, "[policy-migration-guard] check failed (ignored)");
  }
};
