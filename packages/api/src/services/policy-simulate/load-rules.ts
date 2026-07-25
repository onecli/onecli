import { db, Prisma } from "@onecli/db";
import type { PolicyScopeBase } from "../../services/policy-service";

// The rule read behind the simulator and the reflections — mirrors the
// GATEWAY's load, not the editor's (`listPolicyRules` excludes Default Rules,
// ignores `enabled`, and returns DTOs): enabled rules only, Default Rules
// INCLUDED (they drive the deny-default terminal), published pinned to the
// active max generation. Only PERSISTED default rows load — the gateway knows
// nothing of the API's "virtual default" display concept, and a missing default
// is exactly "this level contributes no verdict" under the uniform law.
//
// The gateway reads the set TWICE for two different questions, and so does
// this module — see the two exports at the bottom:
//   - DECISION (`assemble_v2`)   → `equipment` rows DROPPED. They inject a
//     credential without permitting its host, so letting one into the decision
//     set would silently allow traffic nothing granted.
//   - INJECTION (`inject_select`) → `equipment` rows KEPT. They are what a
//     selective agent's credentials are actually made of.
// Asking one question of the other set is the bug this split exists to make
// impossible; every caller must name which it wants.

const SIM_INCLUDE = {
  identities: true,
  targets: true,
} satisfies Prisma.PolicyRuleV2Include;

export type SimRuleRow = Prisma.PolicyRuleV2GetPayload<{
  include: typeof SIM_INCLUDE;
}>;

const loadRules = async (
  base: PolicyScopeBase,
  status: "draft" | "published",
  includeEquipment: boolean,
): Promise<SimRuleRow[]> => {
  const where: Prisma.PolicyRuleV2WhereInput = {
    ...base,
    status,
    enabled: true,
    ...(includeEquipment ? {} : { source: { not: "equipment" } }),
  };
  if (status === "published") {
    const agg = await db.policyRuleV2.aggregate({
      where: { ...base, status: "published" },
      _max: { generation: true },
    });
    if (agg._max.generation === null) return [];
    where.generation = agg._max.generation;
  }
  return db.policyRuleV2.findMany({
    where,
    include: SIM_INCLUDE,
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
};

/** The DECISION set — what block/allow evaluates. Equipment rows are dropped,
 * exactly as the gateway's `assemble_v2` drops them by source. */
export const loadRulesForSimulation = (
  base: PolicyScopeBase,
  status: "draft" | "published",
): Promise<SimRuleRow[]> => loadRules(base, status, false);

/**
 * The INJECTION set — which credentials a selective agent actually receives.
 * This one KEEPS `equipment` rows, mirroring the gateway's `inject_select`,
 * which walks every published allow rule with an explicit identity regardless of
 * source. The two sets differ by design: an equipment rule injects a credential
 * WITHOUT permitting its host, so it must be invisible to the decision engine
 * and visible here. Reading the decision set for an injection question is what
 * made the old probe under-report a selective agent's credentials.
 */
export const loadInjectionRules = (
  base: PolicyScopeBase,
  status: "draft" | "published",
): Promise<SimRuleRow[]> => loadRules(base, status, true);
