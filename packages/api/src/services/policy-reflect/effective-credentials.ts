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
// the rules ALLOW, never the raw injection view): the credentials an agent can
// inject, each tagged with what it can actually DO under the enforced rules
// (Usable / Limited / Blocked). An attached-but-blocked credential reads
// "Blocked", not "available".
//
// The injectable SET mirrors `inject_select.rs` / `connect.rs` (step 7: every
// agent is rule-selected): the published v2 RULE GRANTS and nothing else —
// enabled allow rules whose identity EXPLICITLY names the agent (an EMPTY
// identity never injects; the four target arms: `secretId`, `secretScope`
// level pool, `connectionId`, `app` WITH `connectionScope`). The rule set is
// the INJECTION one, which keeps `source="equipment"` rows — the retired
// per-agent assignments live on as those, and `inject_select` walks them like
// any other grant. Pool grants EXPAND to their concrete credentials so each
// shows its own status. Rule-named ids resolve through the same org+project
// fence the gateway uses — a foreign/deleted id resolves to nothing
// (fail-closed).
//
// Each credential's STATUS is the same engine the App Permissions reflection
// uses: a connection's = its provider's per-tool decision rollup; a secret's =
// its host decision (with the secret assumed attached).
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
      /** The ORGANIZATION blocks every tool of this connection for this agent.
       * Distinct from `status: "blocked"`, which doesn't say who blocked: a
       * project can lift its own block, but not the organization's. */
      orgBlocked: boolean;
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
 * (the shared `rollupToolStatus`, so it matches the connection→agents dialog),
 * plus whether the ORGANIZATION is what blocks it.
 *
 * The connection id is threaded as the winning connection so per-account rules
 * bind exactly as the gateway would — without it, an org rule targeting THIS
 * specific connection matches nothing here and the row reads "usable" while
 * every request 403s.
 *
 * `orgBlocked` comes from the same engine run: `orgCeiling` is the org-alone
 * verdict already computed per tool, so attributing the block costs nothing
 * extra. It is what lets the UI say "Blocked by your organization" — and stop
 * offering a toggle that could only grant more of nothing.
 */
const connectionAccessStatus = (
  provider: string,
  connectionId: string,
  engine: EngineCtx,
): { status: CredentialAccessStatus; orgBlocked: boolean } => {
  const def = getAppPermissionDefinition(provider);
  // Custom app — no catalog to evaluate against.
  if (!def) return { status: "unknown", orgBlocked: false };
  const { groups } = computeEffectiveGroups({
    def,
    ...engine,
    winningConnectionId: connectionId,
  });
  const tools = groups.flatMap((g) => g.tools);
  return {
    status: rollupToolStatus(tools.map((t) => t.verdict)),
    orgBlocked:
      tools.length > 0 && tools.every((t) => t.orgCeiling === "block"),
  };
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
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");

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
    resolvePrincipalSet(ctx.projectId, ctx.organizationId),
    // DECISION rules — equipment dropped, as the gateway's assembler drops them.
    loadRulesForSimulation(orgBase, "published"),
    loadRulesForSimulation(projectBase, "published"),
    // INJECTION rules — equipment KEPT, as `inject_select` keeps them. These
    // are what an agent's credentials actually come from since step 10 (and
    // the ONLY source since step 7 — there is no all-mode pool arm left); the
    // frozen per-agent grant tables are no longer consulted, so a revoked
    // grant stops being listed instead of lingering as "assigned".
    loadInjectionRules(orgBase, "published"),
    loadInjectionRules(projectBase, "published"),
    loadSecretHosts(ctx.organizationId, ctx.projectId),
    loadConnectionProviders(ctx.organizationId, ctx.projectId),
  ]);
  const allRows = [...orgRows, ...projectRows];
  const injectRows = [...orgInjectRows, ...projectInjectRows];

  const provenance = new ProvenanceMap();
  const secretById = new Map<string, SecretResolved>();
  const connectionById = new Map<string, ConnectionResolved>();

  {
    // Exactly the rule grants (step 7: every agent is rule-selected; the
    // all-mode whole-pool arm is gone). The old per-agent grant tables became
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
    ...connectionAccessStatus(c.provider, c.id, engine),
    provenance: provenance.for(`connection:${c.id}`, ctx.viewerSeesOrgRules),
  }));

  return {
    agentId: agent.id,
    // Constant since step 7 — the union's "all" arm stays for wire compat and
    // narrows away with the column in step 8.
    mode: "selective",
    secrets,
    connections,
  };
};
