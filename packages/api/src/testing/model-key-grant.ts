import type { db as Db } from "@onecli/db";

/**
 * Give a hosted agent a model key the way the product does: a workspace
 * `anthropic` secret, and a published `equipment` rule that grants it to the
 * agent. Door 1 of every turn (`findAgentLlmBlocker`) reads this grant, so a
 * pg suite that drives turns seeds it; without it the turn fails
 * `no_model_key`.
 *
 * `name` names the secret and the rule (its `logicalId` too), so a suite that
 * prefixes it with its own fence removes both in its cleanup.
 *
 * TESTS ONLY. Takes the suite's client rather than importing one, and imports
 * nothing at runtime, so a suite that pins its edition before loading
 * anything stays lane-invariant (see `lane-invariant.ts`).
 */
export const grantModelKey = async (
  db: typeof Db,
  grant: { workspaceId: string; agentId: string; name: string },
): Promise<void> => {
  const secret = await db.secret.create({
    data: {
      scope: "workspace",
      workspaceId: grant.workspaceId,
      name: grant.name,
      type: "anthropic",
      encryptedValue: "enc",
      hostPattern: "api.anthropic.com",
      metadata: { authMode: "api-key" },
    },
    select: { id: true },
  });
  await db.policyRuleV2.create({
    data: {
      scope: "workspace",
      workspaceId: grant.workspaceId,
      status: "published",
      generation: 1,
      priority: 10,
      isDefault: false,
      enabled: true,
      source: "equipment",
      logicalId: grant.name,
      name: grant.name,
      action: "allow",
      requireApproval: false,
      identities: { create: [{ agentId: grant.agentId }] },
      targets: { create: [{ kind: "secret", secretId: secret.id }] },
    },
  });
};
