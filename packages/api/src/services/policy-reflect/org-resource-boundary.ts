import type { SimRuleRow } from "../policy-simulate/load-rules";
import type { PrincipalSet } from "../policy-simulate/principal-set";
import {
  isSessionPolicy,
  type SessionPolicyInput,
} from "../../validations/policy";
import { injectionIdentityMatches } from "./injection";
import { intersectPolicies } from "../../lib/resource-axis";

/**
 * LICENSED-MIRROR: deliberate Apache twin of the gateway's boundary
 * derivation (`collect_boundaries`, apps/gateway/crates/policy-engine/src/inject_select.rs
 * — itself dual-use shared code whose resource-scope composition delegates to
 * the licensed `ee/granular_access`). The free effective-permissions
 * reflection executes this file, so it must NOT move into `ee/` — declared in
 * ee-boundary.ts LICENSED_MIRRORS.
 *
 * The ORGANIZATION's resource boundary for one (agent, connection): how far the
 * org allows that connection's injected credential to reach, whatever a workspace
 * grant then selects within it.
 *
 * Mirrors the gateway's `collect_boundaries` exactly, including its identity
 * law — which is the DECISION engine's, not the injection engine's: a rule
 * naming no identity bounds EVERY agent. The two laws differ deliberately.
 * Granting a credential to "everyone by omission" would be a leak, but
 * restricting everyone is the plain reading of an organization-wide rule and
 * can only tighten access.
 */
const boundaryIdentityMatches = (
  identities: SimRuleRow["identities"],
  agentId: string,
  principals: PrincipalSet,
): boolean =>
  identities.length === 0 ||
  identities.some((i) => {
    if (i.agentId != null) return i.agentId === agentId;
    if (i.userId != null) return principals.userIds.includes(i.userId);
    if (i.groupId != null) return principals.groupIds.includes(i.groupId);
    return false;
  });

/**
 * Fold one scope's published injection rules into the session policy they leave
 * on a connection. Last match wins within the scope (the gateway's map-insert
 * order), and the final value must be an object session policy — jsonb `null`
 * and behavioral arrays restrict no resources.
 */
const foldSessionPolicy = (
  rows: SimRuleRow[],
  connectionId: string,
  identityMatches: (identities: SimRuleRow["identities"]) => boolean,
): SessionPolicyInput | null => {
  let policy: unknown = null;
  for (const row of rows) {
    if (row.isDefault || row.action !== "allow") continue;
    if (!identityMatches(row.identities)) continue;
    if (
      !row.targets.some(
        (t) => t.kind === "connection" && t.appConnectionId === connectionId,
      )
    ) {
      continue;
    }
    policy = row.conditions;
  }
  return isSessionPolicy(policy) ? policy : null;
};

/**
 * The ORG's boundary for one (agent, connection) — decision identity law.
 *
 * Unlike a scope's own selection this is NOT last-match-wins: only rules that
 * actually restrict count (a plain org attach of the same connection carries no
 * policy and must not erase a real boundary by sorting later), and where
 * several org rules each constrain the connection, every one of them applies —
 * so they compose. Mirrors `collect_boundaries` in the gateway.
 */
export const orgResourceBoundary = (
  orgInjectionRows: SimRuleRow[],
  agentId: string,
  principals: PrincipalSet,
  connectionId: string,
): SessionPolicyInput | null => {
  let boundary: SessionPolicyInput | null = null;
  for (const row of orgInjectionRows) {
    if (row.isDefault || row.action !== "allow") continue;
    if (!boundaryIdentityMatches(row.identities, agentId, principals)) continue;
    if (!isSessionPolicy(row.conditions)) continue;
    if (
      !row.targets.some(
        (t) => t.kind === "connection" && t.appConnectionId === connectionId,
      )
    ) {
      continue;
    }
    boundary =
      boundary === null
        ? row.conditions
        : intersectPolicies(boundary, row.conditions);
  }
  return boundary;
};

/**
 * The WORKSPACE's own selection for one (agent, connection) — the grant stack's
 * session policy, under the injection engine's EXPLICIT-identity law (a rule
 * naming nobody grants nobody a credential, so it selects nothing either).
 */
export const workspaceResourceSelection = (
  workspaceInjectionRows: SimRuleRow[],
  agentId: string,
  principals: PrincipalSet,
  connectionId: string,
): SessionPolicyInput | null =>
  foldSessionPolicy(workspaceInjectionRows, connectionId, (identities) =>
    injectionIdentityMatches(identities, agentId, principals),
  );
