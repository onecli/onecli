/**
 * The OSS new-project policy seeder (wired via the OSS init seam). Since step 10
 * the legacy→v2 cutover machinery is gone; this file keeps only the v2-native
 * seeder that gives a fresh project its published Default Rule.
 */
import { db } from "@onecli/db";
import { backfillPublishScope, type BackfillRuleInput } from "./policy-service";

/** The seeded per-project Default Rule (allow- or deny-by-default per the
 * instance posture). Priority is assigned by the caller (last).
 *
 * `posture`, not `policyMode`: it is derived from the oldest project's PUBLISHED
 * default below, never from the deprecated `Organization.policyMode` column — so
 * a grep for that column at drop time doesn't stop here. */
const ossProjectDefaultRule = (posture: string): BackfillRuleInput => ({
  priority: 0,
  isDefault: true,
  source: "default",
  name: "Default Rule",
  action: posture === "deny" ? "block" : "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [],
});

/**
 * Seed a fresh project's published Default Rule from the INSTANCE POSTURE — the
 * oldest project's published Default-Rule action (fresh install → Allow) — so a
 * deny-posture instance doesn't mint allow-by-default projects, and the new
 * project enforces v2 from birth (the published generation is the gateway's
 * per-project enforce signal). Org-only calls no-op: OSS has no org scope.
 */
export const ossNewProjectPolicySeeder = {
  seed: async (_organizationId: string, projectId?: string): Promise<void> => {
    if (!projectId) return;
    // The instance posture: the OLDEST project's ACTIVE default. Two steps,
    // because a project retains several published generations (each snapshot
    // carries its own default row) — a single findFirst without a generation
    // bound would read a nondeterministic historical default.
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
