import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import { LLM_PROVIDER_IDS, isLlmProviderId } from "../llm/registry";
import { resolveAgentLlmCredential } from "./llm-credential-service";
import { setSecretGrant, type GrantScope } from "./grants-service";
import {
  recordAuditEvent,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
} from "./audit-service";

/**
 * "A new agent can actually run" — the auto-attach.
 *
 * Every agent is rule-selected and fails closed (`injectableSecretWhere`
 * selects NOTHING without grants), which is the right default for arbitrary
 * credentials and the wrong one for the single credential that makes an agent
 * an agent. Without this, creating an agent produced one that 401s at the
 * gateway until someone found the Models tab and attached a key by hand.
 *
 * Its OWN module rather than a corner of `grants-service` for the same reason
 * `injectable-secrets` is: this is a POLICY about who should hold a key,
 * composed from the grant writer and the credential resolver, while
 * `grants-service` is the mechanism that executes an already-made decision.
 * Keeping the policy out of the mechanism is also what stops the two
 * creation surfaces (the /v1 routes and the web server actions) from growing
 * separate copies of it.
 *
 * Two laws hold across both directions:
 *  - **Typed LLM keys only.** Generic secrets stay an explicit, per-agent
 *    decision — "every new agent gets every credential" would invert the
 *    fail-closed default the whole grants model rests on.
 *  - **Widen only into emptiness.** Nothing here ever re-points an agent
 *    someone deliberately configured; it only turns "cannot run" into
 *    "can run".
 *
 * Best-effort by contract, and that is deliberate: creating an agent or a key
 * must never fail because a convenience grant did. Callers get back what
 * actually happened so the UI can say so rather than guess.
 */

/** The attach pool, mirroring `grants-service`: the workspace's own secrets
 * plus org-shared ones under the acting org — the same fence every hand-made
 * grant passes. */
const poolWhere = (scope: GrantScope) => ({
  OR: [
    { workspaceId: scope.workspaceId },
    { organizationId: scope.organizationId, scope: "organization" },
  ],
});

/**
 * Resolve the grant scope from the workspace ALONE.
 *
 * Both entry points take a workspace id rather than a `GrantScope`, and the
 * org is read from the workspace row here. That is a fencing decision, not a
 * convenience: a caller cannot pass an organization that disagrees with the
 * workspace, so the attach pool can never be widened by a mismatched pair.
 * Null (a workspace that vanished mid-request) means "attach nothing".
 */
const log = logger.child({ component: "llm-autoattach" });

const scopeFor = async (workspaceId: string): Promise<GrantScope | null> => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return workspace
    ? { workspaceId, organizationId: workspace.organizationId }
    : null;
};

/**
 * Record the grants this module made.
 *
 * Every OTHER grant write in the product is audited (`grants.ts` wraps each
 * route in `withAudit`), and an automatic grant is exactly the kind a
 * compliance reader must be able to find later — "who gave this agent that
 * key?" cannot answer "nobody, silently". Attributed to the acting user when
 * there is one; a keyless caller (an org API key with no user) records
 * nothing rather than inventing an actor, matching the precedent in
 * `platform-tool-service`.
 *
 * `recordAuditEvent` never throws, so this cannot turn a successful create
 * into a failed request.
 */
const auditAutoGrants = async (
  scope: GrantScope,
  userId: string | null,
  metadata: Record<string, string | string[]>,
): Promise<void> => {
  if (!userId) return;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) return;
  await recordAuditEvent({
    workspaceId: scope.workspaceId,
    userId,
    userEmail: user.email,
    action: AUDIT_ACTIONS.UPDATE,
    service: AUDIT_SERVICES.GRANT,
    source: AUDIT_SOURCE.API,
    // Ids and names only — never a credential value (§4).
    metadata: { ...metadata, auto: "llm-autoattach" },
  });
};

/**
 * Attach every LLM key the workspace already has to a NEWLY CREATED agent.
 *
 * Idempotent per key (`setSecretGrant` writes nothing when the desired stack
 * already exists), so re-running it — or re-creating an identifier — is free.
 * An empty result is the honest signal that the workspace has no key yet, and
 * the dashboard turns it into a guided "add one now" instead of a silent dead
 * agent.
 */
export const autoAttachLlmKeys = async (
  workspaceId: string,
  agentId: string,
  userId: string | null,
): Promise<{ secretIds: string[] }> => {
  const scope = await scopeFor(workspaceId);
  if (!scope) return { secretIds: [] };

  const keys = await db.secret.findMany({
    where: { ...poolWhere(scope), type: { in: LLM_PROVIDER_IDS } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const secretIds: string[] = [];
  // SEQUENTIAL on purpose, here and below: `setSecretGrant` takes the
  // per-scope advisory lock and republishes the whole draft rule set, so
  // running these concurrently would serialize on the lock anyway — and race
  // to publish. The counts are small (the LLM keys of one workspace).
  for (const key of keys) {
    try {
      await setSecretGrant(scope, agentId, key.id, userId);
      secretIds.push(key.id);
    } catch (err) {
      // One unattachable key must not cost the others, nor the agent — but a
      // silent swallow would make "my agent still cannot run" undiagnosable.
      log.warn(
        { err, agentId, secretId: key.id },
        "auto-attach of LLM key failed",
      );
    }
  }
  if (secretIds.length > 0) {
    await auditAutoGrants(scope, userId, { agentId, secretIds });
  }
  return { secretIds };
};

/**
 * The mirror, for the other order of events: the key arrives AFTER the agents
 * do (the common first run — create an agent, discover it has no key, add
 * one).
 *
 * Only agents that can currently reach NO LLM key are touched, and the
 * question is asked with the GATEWAY'S OWN predicate
 * (`resolveAgentLlmCredential`) rather than a second opinion — a second
 * opinion here would produce exactly the failure this whole area exists to
 * prevent: an agent the dashboard calls ready that the gateway 401s. Adding a
 * second key therefore widens nothing, and a deliberate per-agent choice is
 * never overridden.
 */
export const attachLlmKeyToKeylessAgents = async (
  workspaceId: string,
  secretId: string,
  userId: string | null,
): Promise<{ agentIds: string[] }> => {
  const scope = await scopeFor(workspaceId);
  if (!scope) return { agentIds: [] };

  const secret = await db.secret.findFirst({
    where: { id: secretId, ...poolWhere(scope) },
    select: { id: true, type: true },
  });
  if (!secret || !isLlmProviderId(secret.type)) return { agentIds: [] };

  const agents = await db.agent.findMany({
    where: { workspaceId: scope.workspaceId },
    select: { id: true, workspaceId: true },
  });
  const agentIds: string[] = [];
  for (const agent of agents) {
    try {
      const current = await resolveAgentLlmCredential(
        agent,
        scope.organizationId,
      );
      // The platform trial credential must NOT count as "has a key" here.
      // Today this arm is defense: the key being attached is already in the
      // pool, which makes the trial ineligible, so `current` can't be the
      // platform credential in this loop. But if the eligibility rule ever
      // loosens, skipping the attach would strand the agent — running on
      // trial credit until the real key's presence turns the trial off, then
      // holding no credential at all. Pinned so that change can't ship this
      // bug silently.
      if (current && current.scope !== "platform") continue;
      await setSecretGrant(scope, agent.id, secret.id, userId);
      agentIds.push(agent.id);
    } catch (err) {
      // Best-effort: one agent's failure must not cost the key's creation.
      log.warn(
        { err, agentId: agent.id, secretId: secret.id },
        "auto-attach of new LLM key to keyless agent failed",
      );
    }
  }
  if (agentIds.length > 0) {
    await auditAutoGrants(scope, userId, { secretId: secret.id, agentIds });
  }
  return { agentIds };
};
