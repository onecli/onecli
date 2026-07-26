import type { OldCondition } from "../policy-translation/types";
import type {
  NewIdentity,
  NewRule,
  NewTarget,
} from "../policy-translation/types";
import type { SimRuleRow } from "./load-rules";
import type { SecretHostSet } from "./secret-hosts";

// Row → evaluator-rule mapper for the simulator and the reflections. Mirrors
// the gateway's row decode: identities decode all FOUR
// kinds (the verify path is agent-only by design and stays untouched), `secret`
// targets resolve to their gated host patterns via the fenced `SecretHostSet`,
// and `connection` targets resolve to their connection's provider via the
// fenced provider map (→ an app target carrying the target's own tools — empty
// = the provider's whole app, host-only; named = the tool fan-out), exactly as
// the gateway's `assemble.rs::decode_row` does at connect. The rule's identity
// metadata (row id, generation-stable logicalId) rides beside the engine rule
// so the simulator can NAME the deciding rule without widening the shared
// `NewRule` shape.

export interface SimRuleMeta {
  id: string;
  logicalId: string;
  name: string;
  scope: "organization" | "project";
  source: string;
}

export interface SimRule {
  meta: SimRuleMeta;
  rule: NewRule;
}

const decodeIdentities = (row: SimRuleRow): NewIdentity[] =>
  row.identities.map((i): NewIdentity => {
    if (i.agentId != null) return { type: "agent", id: i.agentId };
    if (i.agentGroupId != null)
      return { type: "agentGroup", id: i.agentGroupId };
    if (i.userId != null) return { type: "user", id: i.userId };
    if (i.groupId != null) return { type: "group", id: i.groupId };
    // No principal (impossible per the DB `one_principal` CHECK) — mirror the
    // gateway's `Identity::Unresolved`: keep a NEVER-matching entry so the row
    // narrows the rule; dropping it would flip `identities: []` = "any agent".
    // An agent id is never the empty string, so this can't match.
    return { type: "agent", id: "" };
  });

/** Mirror of `assemble.rs::secret_target_hosts`: a specific secret → its one
 * host (absent from the fenced set → none → never matches, fail-closed); a
 * level scope → that level's union. */
const secretTargetHosts = (
  target: SimRuleRow["targets"][number],
  secretHosts: SecretHostSet,
): string[] => {
  if (target.secretId) {
    const host = secretHosts.byId.get(target.secretId);
    return host === undefined ? [] : [host];
  }
  if (target.secretScope === "project") return [...secretHosts.projectHosts];
  if (target.secretScope === "organization") return [...secretHosts.orgHosts];
  return [];
};

const decodeTarget = (
  target: SimRuleRow["targets"][number],
  secretHosts: SecretHostSet,
  connectionProviders: Map<string, string>,
): NewTarget => {
  switch (target.kind) {
    case "app":
      // A provider-less app row mirrors `Target::Unresolved` — map to an inert
      // connection target (the evaluator never matches those).
      if (!target.appProvider) {
        return { kind: "connection", connectionId: "", tools: [] };
      }
      return {
        kind: "app",
        provider: target.appProvider,
        tools: target.appTools,
        connectionScope:
          target.appConnectionScope === "organization" ||
          target.appConnectionScope === "project"
            ? target.appConnectionScope
            : null,
      };
    case "connection": {
      // Mirror of the gateway's `assemble.rs` connection arm: resolve the
      // connection to its provider (fenced map) → an app target carrying the
      // target's own tools (empty → the provider's whole app, host-only; named →
      // the tool fan-out). A missing/deleted/foreign id stays an inert connection
      // target (unresolved — fail-closed).
      const provider = target.appConnectionId
        ? connectionProviders.get(target.appConnectionId)
        : undefined;
      if (provider !== undefined) {
        return {
          kind: "app",
          provider,
          tools: target.appTools,
          connectionScope: null,
        };
      }
      return {
        kind: "connection",
        connectionId: target.appConnectionId ?? "",
        tools: [],
      };
    }
    case "secret":
      return {
        kind: "secret",
        hostPatterns: secretTargetHosts(target, secretHosts),
      };
    case "network":
      return {
        kind: "network",
        hostPattern: target.hostPattern ?? "",
        pathPattern: target.pathPattern,
        method: target.method,
      };
    default:
      // Unknown kind → inert (mirror of `Target::Unresolved`).
      return { kind: "connection", connectionId: "", tools: [] };
  }
};

/** Mirror of the gateway's all-or-nothing `parse_conditions`: a non-array, or
 * any element missing target/operator/value strings, makes the WHOLE conditions
 * match unconditionally (null). */
const decodeConditions = (conditions: unknown): OldCondition[] | null => {
  if (!Array.isArray(conditions)) return null;
  const decoded: OldCondition[] = [];
  for (const c of conditions) {
    if (
      typeof c !== "object" ||
      c === null ||
      typeof (c as Record<string, unknown>).target !== "string" ||
      typeof (c as Record<string, unknown>).operator !== "string" ||
      typeof (c as Record<string, unknown>).value !== "string"
    ) {
      return null;
    }
    const e = c as { target: string; operator: string; value: string };
    decoded.push({ target: e.target, operator: e.operator, value: e.value });
  }
  return decoded;
};

export const toSimRule = (
  row: SimRuleRow,
  secretHosts: SecretHostSet,
  connectionProviders: Map<string, string>,
): SimRule => ({
  meta: {
    id: row.id,
    logicalId: row.logicalId,
    name: row.name,
    scope: row.scope === "organization" ? "organization" : "project",
    source: row.source,
  },
  rule: {
    scope: row.scope === "organization" ? "organization" : "project",
    priority: row.priority,
    isDefault: row.isDefault,
    source:
      row.source === "app_permission" ||
      row.source === "blocklist" ||
      row.source === "default" ||
      row.source === "equipment"
        ? row.source
        : "custom",
    name: row.name,
    action: row.action === "block" ? "block" : "allow",
    requireApproval: row.requireApproval,
    rateLimit: row.rateLimit,
    rateLimitWindow:
      row.rateLimitWindow === "minute" ||
      row.rateLimitWindow === "hour" ||
      row.rateLimitWindow === "day"
        ? row.rateLimitWindow
        : null,
    conditions: decodeConditions(row.conditions),
    identities: decodeIdentities(row),
    targets: row.targets.map((t) =>
      decodeTarget(t, secretHosts, connectionProviders),
    ),
  },
});
