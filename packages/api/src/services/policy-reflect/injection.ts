import type { SimRuleRow } from "../policy-simulate/load-rules";
import type { PrincipalSet } from "../policy-simulate/principal-set";
import type { SecretHostSet } from "../policy-simulate/secret-hosts";
import { hostMatches } from "../../lib/path-match";
import { providerHostMatches } from "../policy-translation/translate/app-catalog";

// The shared injection law for the 9.7b reflections — a faithful mirror of the
// gateway's `inject_select.rs` + `connect.rs` connect-time credential selection,
// so the "credential attached" and "hasInjections" signals across all three
// reflections agree with what the gateway would actually inject.

/**
 * `inject_select.rs::identity_matches`: injection requires an EXPLICIT identity
 * in the agent's principal set (own id, or an inherited agent-group / user /
 * group). Unlike the block/allow engine — where empty identities mean "any" — an
 * EMPTY identity here NEVER matches (a credential must not inject to every
 * agent; also the orphan guard: a deleted agent's cascaded-empty rule must not
 * widen to "any").
 */
export const injectionIdentityMatches = (
  identities: SimRuleRow["identities"],
  agentId: string,
  principals: PrincipalSet,
): boolean =>
  identities.length > 0 &&
  identities.some((i) => {
    if (i.agentId != null) return i.agentId === agentId;
    if (i.agentGroupId != null)
      return principals.agentGroupIds.includes(i.agentGroupId);
    if (i.userId != null) return principals.userIds.includes(i.userId);
    if (i.groupId != null) return principals.groupIds.includes(i.groupId);
    // No principal (the DB one_principal CHECK makes this unreachable) — never
    // widen to "any".
    return false;
  });

/**
 * Which SECRETS a selective agent's published rules grant it: specific ids, plus
 * any whole-level grants (a `secretScope` target widens to that level's pool).
 * The id-level counterpart of `buildInjectionProbe`, for callers that need the
 * secrets themselves rather than a host predicate — the container config picks
 * the agent's LLM credential this way.
 *
 * Pure: the caller supplies the already-fenced rules, so a foreign id can only
 * come back if it was already in the caller's own scope.
 */
export const grantedSecretSelection = (
  rules: SimRuleRow[],
  agentId: string,
  principals: PrincipalSet,
): { ids: string[]; levels: Set<"project" | "organization"> } => {
  const ids = new Set<string>();
  const levels = new Set<"project" | "organization">();
  for (const row of rules) {
    if (row.isDefault || row.action !== "allow") continue;
    if (!injectionIdentityMatches(row.identities, agentId, principals))
      continue;
    for (const t of row.targets) {
      if (t.kind !== "secret") continue;
      if (t.secretId) ids.add(t.secretId);
      else if (t.secretScope === "project") levels.add("project");
      else if (t.secretScope === "organization") levels.add("organization");
    }
  }
  return { ids: [...ids], levels };
};

/**
 * Build the host-match predicate for whether a credential would INJECT for an
 * agent + host (the deny-default carve's `hasInjections` input). The injectable
 * set is the union of:
 *  - the agent's assigned/pool credentials (`poolSecretHostPatterns` /
 *    `poolProviders`, already loaded — the assigned set for a selective agent,
 *    the whole fenced pool for all-mode / the baseline);
 *  - for a SELECTIVE agent, its published v2 RULE GRANTS (allow rules whose
 *    explicit identity matches): a `secret` target → its host (by id, or the
 *    level pool's hosts), a `connection` target → its provider, an `app` target
 *    WITH `connectionScope` → its provider (an app target WITHOUT one is
 *    block/allow only, never injection). Resolved through the already-fenced
 *    `secretHosts` / `connectionProviders` maps, so a foreign/deleted id
 *    contributes nothing (fail-closed).
 * All-mode / baseline agents already draw the whole pool (a rule grant is always
 * a subset), so only the selective arm folds the grants in.
 */
export const buildInjectionProbe = (params: {
  agent: { id: string; secretMode: string } | null;
  poolSecretHostPatterns: string[];
  poolProviders: string[];
  rules: SimRuleRow[];
  principals: PrincipalSet;
  secretHosts: SecretHostSet;
  connectionProviders: Map<string, string>;
}): ((host: string) => boolean) => {
  const secretPatterns = [...params.poolSecretHostPatterns];
  const providers = new Set(params.poolProviders);

  if (params.agent && params.agent.secretMode === "selective") {
    const agentId = params.agent.id;
    for (const row of params.rules) {
      if (row.isDefault || row.action !== "allow") continue;
      if (!injectionIdentityMatches(row.identities, agentId, params.principals))
        continue;
      for (const t of row.targets) {
        if (t.kind === "secret") {
          if (t.secretId) {
            const host = params.secretHosts.byId.get(t.secretId);
            if (host !== undefined) secretPatterns.push(host);
          } else if (t.secretScope === "project") {
            secretPatterns.push(...params.secretHosts.projectHosts);
          } else if (t.secretScope === "organization") {
            secretPatterns.push(...params.secretHosts.orgHosts);
          }
        } else if (t.kind === "connection") {
          if (t.appConnectionId) {
            const provider = params.connectionProviders.get(t.appConnectionId);
            if (provider !== undefined) providers.add(provider);
          }
        } else if (t.kind === "app") {
          if (
            t.appProvider &&
            (t.appConnectionScope === "project" ||
              t.appConnectionScope === "organization")
          ) {
            // Provider-level: we fold the provider without checking that a live
            // connection of it exists, so a scope grant with zero connected
            // connections can over-report `hasInjections` (a tool the grant's
            // own tools don't cover would then read "block" via the deny-default
            // rather than "unmanaged"). This errs MORE restrictive — safe for a
            // read-only reflection — and is the documented injection-probe
            // approximation. In the common no-tool-narrowing case the grant also
            // permits the provider's hosts in the block/allow engine, so the
            // verdict is "allow" and `hasInjections` is moot.
            providers.add(t.appProvider);
          }
        }
      }
    }
  }

  const providerList = [...providers];
  return (host: string) =>
    secretPatterns.some((p) => hostMatches(host, p)) ||
    providerList.some((p) => providerHostMatches(host, p));
};
