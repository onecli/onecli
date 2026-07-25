import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { getAppPermissionDefinition } from "../../apps/app-permissions";
import { hostMatches, isLlmHost } from "../../lib/path-match";
import { providerHostMatches } from "../policy-translation/translate/app-catalog";
import {
  evaluatePolicyOutcome,
  outcomeToDecision,
} from "../policy-translation/evaluator";
import type { NewRule } from "../policy-translation/types";
import {
  loadInjectionRules,
  loadRulesForSimulation,
} from "../policy-simulate/load-rules";
import {
  resolvePrincipalSet,
  type PrincipalSet,
} from "../policy-simulate/principal-set";
import { loadConnectionProviders } from "../policy-simulate/connection-providers";
import { loadSecretHosts } from "../policy-simulate/secret-hosts";
import { toSimRule, type SimRule } from "../policy-simulate/sim-rule";
import {
  computeEffectiveGroups,
  rollupToolStatus,
  synthesizeHost,
} from "./effective-tools";
import { injectionIdentityMatches } from "./injection";

// The "Credential access" dialog's reflection (step 9.7b),
// framed around EFFECTIVE ACCESS (the user decision — reflections lead with what
// the rules ALLOW, never the injection/`secretMode` view): the credentials an
// agent can inject, each tagged with what it can actually DO under the enforced
// rules (Usable / Limited / Blocked). An all-mode agent gets the whole pool
// attached, but a Block rule denies its requests — so an attached-but-blocked
// credential reads "Blocked", not "available".
//
// The injectable SET mirrors `inject_select.rs` / `connect.rs`:
//   - ALL-mode → the whole fenced org+project pool (rules can't narrow it).
//   - SELECTIVE → the published v2 RULE GRANTS and nothing else — enabled allow
//     rules whose identity EXPLICITLY names the agent (an EMPTY identity never
//     injects; the four target arms: `secretId`, `secretScope` level pool,
//     `connectionId`, `app` WITH `connectionScope`). The rule set is the
//     INJECTION one, which keeps `source="equipment"` rows — the retired
//     per-agent assignments live on as those, and `inject_select` walks them
//     like any other grant. Pool grants EXPAND to their concrete credentials so
//     each shows its own status. Rule-named ids resolve through the same
//     org+project fence the gateway uses — a foreign/deleted id resolves to
//     nothing (fail-closed).
//
// Each credential's STATUS is the same engine the App Permissions reflection
// uses: a connection's = its provider's per-tool decision rollup; a secret's =
// its host decision (with the secret assumed attached). `secretMode` survives
// only as a demoted footnote in the UI, never the headline.
//
// REDACTION (the simulate contract): org rule NAMES are org-admin-only; multiple
// granting org rules COLLAPSE to one redacted marker (their count isn't
// disclosed either).

export type CredentialAccessStatus =
  /** Requests through this credential are allowed. */
  | "usable"
  /** Some allowed, some blocked or need approval. */
  | "limited"
  /** Every request through it is blocked by a rule. */
  | "blocked"
  /** A custom app with no permission catalog — governed by network rules only. */
  | "unknown";

export type CredentialProvenance =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | {
      kind: "rule";
      scope: "organization" | "project";
      rule: { logicalId: string; name: string };
    };

export type EffectiveCredentialEntry =
  | {
      kind: "secret";
      id: string;
      name: string;
      host: string;
      status: CredentialAccessStatus;
      provenance: CredentialProvenance[];
    }
  | {
      kind: "connection";
      id: string;
      label: string | null;
      provider: string;
      status: CredentialAccessStatus;
      provenance: CredentialProvenance[];
    };

export interface EffectiveCredentialsResult {
  agentId: string;
  /** Demoted to a footnote in the UI — never the headline (the user decision). */
  mode: "all" | "selective";
  secrets: EffectiveCredentialEntry[];
  connections: EffectiveCredentialEntry[];
}

export interface EffectiveCredentialsCtx {
  projectId: string;
  organizationId: string;
  /** Org-admin viewers see org rule details; everyone else gets redaction. */
  viewerSeesOrgRules: boolean;
}

interface RuleRef {
  scope: "organization" | "project";
  logicalId: string;
  name: string;
}

/** Accumulates provenance per credential, collapsing org refs for non-admins. */
class ProvenanceMap {
  private rules = new Map<string, RuleRef[]>();

  addRule(key: string, ref: RuleRef) {
    const list = this.rules.get(key) ?? [];
    list.push(ref);
    this.rules.set(key, list);
  }
  for(key: string, viewerSeesOrgRules: boolean): CredentialProvenance[] {
    const out: CredentialProvenance[] = [];
    const refs = this.rules.get(key) ?? [];
    const seen = new Set<string>();
    let redactedEmitted = false;
    for (const ref of refs) {
      if (ref.scope === "organization" && !viewerSeesOrgRules) {
        // Collapse ALL org refs to ONE redacted marker — their count is org
        // information too.
        if (!redactedEmitted) {
          out.push({ kind: "rule", scope: "organization", redacted: true });
          redactedEmitted = true;
        }
        continue;
      }
      if (seen.has(ref.logicalId)) continue;
      seen.add(ref.logicalId);
      out.push({
        kind: "rule",
        scope: ref.scope,
        rule: { logicalId: ref.logicalId, name: ref.name },
      });
    }
    return out;
  }
}

/** The engine inputs a status computation needs, resolved once per request. */
interface EngineCtx {
  simRules: SimRule[];
  engineRules: NewRule[];
  agentId: string;
  principals: PrincipalSet;
  probe: (host: string) => boolean;
  viewerSeesOrgRules: boolean;
}

/** A connection's effective status = its provider's per-tool decision rollup
 * (the shared `rollupToolStatus`, so it matches the connection→agents dialog). */
const connectionAccessStatus = (
  provider: string,
  engine: EngineCtx,
): CredentialAccessStatus => {
  const def = getAppPermissionDefinition(provider);
  if (!def) return "unknown"; // custom app — no catalog to evaluate against
  const { groups } = computeEffectiveGroups({ def, ...engine });
  return rollupToolStatus(groups.flatMap((g) => g.tools.map((t) => t.verdict)));
};

/** A secret's effective status = the decision on a REPRESENTATIVE request to its
 * host (GET /), with the secret assumed attached (the injecting credential). A
 * whole-host block and an allowlist (project-default Block) both read "blocked"
 * correctly. HONESTY LIMIT (same as `effective-tools`' per-tool view): a
 * method- or path-SPECIFIC block (e.g. only POST, or only `/admin/*`) is not
 * exercised by the representative GET /, so such a secret reads "usable" — an
 * over-optimistic summary a secret (a raw host, no catalog) can't refine. */
const secretAccessStatus = (
  hostPattern: string,
  engine: EngineCtx,
): CredentialAccessStatus => {
  const host = synthesizeHost(hostPattern);
  const outcome = evaluatePolicyOutcome(engine.engineRules, {
    host,
    path: "/",
    method: "GET",
    agentId: engine.agentId,
    agentGroupIds: engine.principals.agentGroupIds,
    userIds: engine.principals.userIds,
    groupIds: engine.principals.groupIds,
    hasInjections: true, // the secret is the attached credential
    isLlmHost: isLlmHost(host),
  });
  return outcomeToDecision(outcome).action === "block" ? "blocked" : "usable";
};

interface SecretResolved {
  id: string;
  name: string;
  hostPattern: string;
}
interface ConnectionResolved {
  id: string;
  label: string | null;
  provider: string;
}

export const effectiveCredentials = async (
  agentId: string,
  ctx: EffectiveCredentialsCtx,
): Promise<EffectiveCredentialsResult> => {
  // The agent must belong to the caller's project — a foreign id is simply not
  // found (existence is never revealed across the fence).
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId: ctx.projectId },
    select: { id: true, secretMode: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
  const selective = agent.secretMode === "selective";

  const secretPoolWhere = (level: "organization" | "project") =>
    level === "project"
      ? { projectId: ctx.projectId }
      : { organizationId: ctx.organizationId, scope: "organization" };
  // Connected-only, matching the gateway's injection pools
  // (`find_app_connections_by_*` all filter `status='connected'`).
  const connectionPoolWhere = (level: "organization" | "project") =>
    level === "project"
      ? { projectId: ctx.projectId, status: "connected" }
      : {
          organizationId: ctx.organizationId,
          scope: "organization",
          status: "connected",
        };
  const anySecretPool = {
    OR: [secretPoolWhere("project"), secretPoolWhere("organization")],
  };
  const anyConnectionPool = {
    OR: [connectionPoolWhere("project"), connectionPoolWhere("organization")],
  };

  const orgBase = {
    scope: "organization" as const,
    organizationId: ctx.organizationId,
  };
  const projectBase = { scope: "project" as const, projectId: ctx.projectId };
  const [
    principals,
    orgRows,
    projectRows,
    orgInjectRows,
    projectInjectRows,
    secretHosts,
    connectionProviders,
  ] = await Promise.all([
    resolvePrincipalSet(agent.id, ctx.projectId, ctx.organizationId),
    // DECISION rules — equipment dropped, as the gateway's assembler drops them.
    loadRulesForSimulation(orgBase, "published"),
    loadRulesForSimulation(projectBase, "published"),
    // INJECTION rules — equipment KEPT, as `inject_select` keeps them. These are
    // what a selective agent's credentials actually come from since step 10; the
    // frozen per-agent grant tables are no longer consulted, so a revoked grant
    // stops being listed instead of lingering as "assigned". An all-mode agent
    // takes the whole pool and never consults them, so don't pay for the reads.
    selective ? loadInjectionRules(orgBase, "published") : [],
    selective ? loadInjectionRules(projectBase, "published") : [],
    loadSecretHosts(ctx.organizationId, ctx.projectId),
    loadConnectionProviders(ctx.organizationId, ctx.projectId),
  ]);
  const allRows = [...orgRows, ...projectRows];
  const injectRows = [...orgInjectRows, ...projectInjectRows];

  const provenance = new ProvenanceMap();
  const secretById = new Map<string, SecretResolved>();
  const connectionById = new Map<string, ConnectionResolved>();

  if (!selective) {
    // ALL mode: the whole fenced pool (rules can't narrow it) — every credential
    // listed with its own effective status; provenance is empty (the mode
    // footnote explains why they're all here). Fences to org+project only; the
    // gateway's all-mode merge also folds cloud-partner-scoped secrets
    // (`connect.rs`), so a partner-injected credential is under-reported here —
    // the same partner blind-spot the injection probe / simulator carry, not a
    // cross-org leak.
    const [secrets, connections] = await Promise.all([
      db.secret.findMany({
        where: anySecretPool,
        select: { id: true, name: true, hostPattern: true },
      }),
      db.appConnection.findMany({
        where: anyConnectionPool,
        select: { id: true, label: true, provider: true },
      }),
    ]);
    for (const s of secrets) secretById.set(s.id, s);
    for (const c of connections) connectionById.set(c.id, c);
  } else {
    // SELECTIVE: exactly the rule grants. The old per-agent grant tables became
    // `source="equipment"` rules at the cutover and are carried by the injection
    // load below, so nothing is lost by not reading them — and a grant the user
    // has since revoked correctly disappears instead of lingering as "assigned".
    //
    // Walk the published allow rules whose identity explicitly names the agent
    // (inject_select.rs `collect`) and gather the injection targets.
    const ruleSecretIds = new Map<string, RuleRef[]>();
    const ruleConnectionIds = new Map<string, RuleRef[]>();
    const secretScopeGrants: {
      level: "organization" | "project";
      ref: RuleRef;
    }[] = [];
    const providerScopeGrants: {
      provider: string;
      level: "organization" | "project";
      ref: RuleRef;
    }[] = [];
    const push = (m: Map<string, RuleRef[]>, id: string, ref: RuleRef) =>
      m.set(id, [...(m.get(id) ?? []), ref]);

    for (const row of injectRows) {
      if (row.isDefault || row.action !== "allow") continue;
      if (!injectionIdentityMatches(row.identities, agent.id, principals))
        continue;
      const ref: RuleRef = {
        scope: row.scope === "organization" ? "organization" : "project",
        logicalId: row.logicalId,
        name: row.name,
      };
      for (const t of row.targets) {
        if (t.kind === "secret") {
          if (t.secretId) push(ruleSecretIds, t.secretId, ref);
          else if (
            t.secretScope === "organization" ||
            t.secretScope === "project"
          )
            secretScopeGrants.push({ level: t.secretScope, ref });
        } else if (t.kind === "connection") {
          if (t.appConnectionId)
            push(ruleConnectionIds, t.appConnectionId, ref);
        } else if (t.kind === "app") {
          if (
            t.appProvider &&
            (t.appConnectionScope === "organization" ||
              t.appConnectionScope === "project")
          )
            providerScopeGrants.push({
              provider: t.appProvider,
              level: t.appConnectionScope,
              ref,
            });
        }
      }
    }

    // Resolve rule-named ids + expand pool grants — all through the org+project
    // fence, so a foreign/deleted id contributes nothing.
    const secretScopeLevels = [
      ...new Set(secretScopeGrants.map((g) => g.level)),
    ];
    const [ruleSecrets, ruleConnections, scopeSecrets, scopeConnections] =
      await Promise.all([
        ruleSecretIds.size > 0
          ? db.secret.findMany({
              where: {
                id: { in: [...ruleSecretIds.keys()] },
                ...anySecretPool,
              },
              select: { id: true, name: true, hostPattern: true },
            })
          : Promise.resolve([]),
        ruleConnectionIds.size > 0
          ? db.appConnection.findMany({
              where: {
                id: { in: [...ruleConnectionIds.keys()] },
                ...anyConnectionPool,
              },
              select: { id: true, label: true, provider: true },
            })
          : Promise.resolve([]),
        secretScopeLevels.length > 0
          ? db.secret.findMany({
              where: { OR: secretScopeLevels.map(secretPoolWhere) },
              select: {
                id: true,
                name: true,
                hostPattern: true,
                scope: true,
                projectId: true,
              },
            })
          : Promise.resolve([]),
        providerScopeGrants.length > 0
          ? db.appConnection.findMany({
              where: {
                provider: {
                  in: [...new Set(providerScopeGrants.map((g) => g.provider))],
                },
                ...anyConnectionPool,
              },
              select: {
                id: true,
                label: true,
                provider: true,
                scope: true,
                projectId: true,
              },
            })
          : Promise.resolve([]),
      ]);

    for (const s of ruleSecrets) {
      secretById.set(s.id, s);
      for (const ref of ruleSecretIds.get(s.id) ?? [])
        provenance.addRule(`secret:${s.id}`, ref);
    }
    for (const c of ruleConnections) {
      connectionById.set(c.id, c);
      for (const ref of ruleConnectionIds.get(c.id) ?? [])
        provenance.addRule(`connection:${c.id}`, ref);
    }
    // Expand a secret-scope grant to every secret at that level.
    const levelOf = (row: { scope: string; projectId: string | null }) =>
      row.scope === "organization" ? "organization" : "project";
    for (const s of scopeSecrets) {
      const rowLevel = levelOf(s);
      const grants = secretScopeGrants.filter((g) => g.level === rowLevel);
      if (grants.length === 0) continue;
      secretById.set(s.id, {
        id: s.id,
        name: s.name,
        hostPattern: s.hostPattern,
      });
      for (const g of grants) provenance.addRule(`secret:${s.id}`, g.ref);
    }
    // Expand a provider-scope grant to every connection of that provider+level.
    for (const c of scopeConnections) {
      const rowLevel = levelOf(c);
      const grants = providerScopeGrants.filter(
        (g) => g.provider === c.provider && g.level === rowLevel,
      );
      if (grants.length === 0) continue;
      connectionById.set(c.id, {
        id: c.id,
        label: c.label,
        provider: c.provider,
      });
      for (const g of grants) provenance.addRule(`connection:${c.id}`, g.ref);
    }
  }

  const secretRows = [...secretById.values()];
  const connectionRows = [...connectionById.values()];
  const simRules = allRows.map((row) =>
    toSimRule(row, secretHosts, connectionProviders),
  );
  const engineRules = simRules.map((s) => s.rule);

  // The injectable-host predicate = the agent's OWN resolved credentials (their
  // hosts / providers). We resolved the full injectable set above, so the probe
  // is that set directly — equivalent to the gateway's connect-time selection
  // for this agent, and self-consistent with the credentials we're listing.
  const providersInjected = [...new Set(connectionRows.map((c) => c.provider))];
  const probe = (host: string) =>
    secretRows.some((s) => hostMatches(host, s.hostPattern)) ||
    providersInjected.some((p) => providerHostMatches(host, p));

  const engine: EngineCtx = {
    simRules,
    engineRules,
    agentId: agent.id,
    principals,
    probe,
    viewerSeesOrgRules: ctx.viewerSeesOrgRules,
  };

  const secrets: EffectiveCredentialEntry[] = secretRows.map((s) => ({
    kind: "secret",
    id: s.id,
    name: s.name,
    host: s.hostPattern,
    status: secretAccessStatus(s.hostPattern, engine),
    provenance: provenance.for(`secret:${s.id}`, ctx.viewerSeesOrgRules),
  }));
  const connections: EffectiveCredentialEntry[] = connectionRows.map((c) => ({
    kind: "connection",
    id: c.id,
    label: c.label,
    provider: c.provider,
    status: connectionAccessStatus(c.provider, engine),
    provenance: provenance.for(`connection:${c.id}`, ctx.viewerSeesOrgRules),
  }));

  return {
    agentId: agent.id,
    mode: selective ? "selective" : "all",
    secrets,
    connections,
  };
};
