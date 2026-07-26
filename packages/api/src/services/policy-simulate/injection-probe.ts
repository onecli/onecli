import { db } from "@onecli/db";
import type { PolicyScopeBase } from "../policy-service";
import { buildInjectionProbe } from "../policy-reflect/injection";
import { loadInjectionRules } from "./load-rules";
import type { PrincipalSet } from "./principal-set";
import { loadSecretHosts } from "./secret-hosts";
import { loadConnectionProviders } from "./connection-providers";

// Derives the simulator's `hasInjections` input: would the gateway inject a
// credential for this agent + host?
//
// This routes through the SHARED `buildInjectionProbe` — the same law the three
// reflections use — rather than carrying a second, weaker copy. The old copy
// answered from the legacy per-agent grant tables, which the gateway stopped
// reading at step 10: a credential granted the normal way, by a policy rule,
// had no row there, so `hasInjections` came back false, the deny-default carve
// (`has_injections && !is_llm_host`) was disarmed, and the simulator reported
// Allow for requests the gateway BLOCKS.
//
// The pool differs by mode, matching `connect.rs`:
//  - "all"       → the whole org+project fenced pool (rules never narrow it);
//  - "selective" → nothing but what its rules grant, so the pool starts empty
//                  and `buildInjectionProbe` folds the grants in.
// The simulator echoes the derived value as "auto" and offers a manual
// override, so the remaining approximation stays visible and escapable.

export const deriveHasInjections = async (
  agent: { id: string; secretMode: string; projectId: string },
  organizationId: string,
  host: string,
  principals: PrincipalSet,
): Promise<boolean> => {
  const selective = agent.secretMode === "selective";

  const poolWhere = {
    OR: [
      { projectId: agent.projectId },
      { organizationId, scope: "organization" },
    ],
  };

  const orgBase: PolicyScopeBase = { scope: "organization", organizationId };
  const projectBase: PolicyScopeBase = {
    scope: "project",
    projectId: agent.projectId,
  };

  const [secrets, connections, orgRules, projectRules, secretHosts, providers] =
    await Promise.all([
      selective
        ? Promise.resolve([])
        : db.secret.findMany({
            where: poolWhere,
            select: { hostPattern: true },
          }),
      selective
        ? Promise.resolve([])
        : db.appConnection.findMany({
            where: { ...poolWhere, status: "connected" },
            select: { provider: true },
          }),
      // Injection rules — equipment INCLUDED, unlike the decision set.
      loadInjectionRules(orgBase, "published"),
      loadInjectionRules(projectBase, "published"),
      loadSecretHosts(organizationId, agent.projectId),
      loadConnectionProviders(organizationId, agent.projectId),
    ]);

  const probe = buildInjectionProbe({
    agent,
    poolSecretHostPatterns: secrets.map((s) => s.hostPattern),
    poolProviders: [...new Set(connections.map((c) => c.provider))],
    rules: [...orgRules, ...projectRules],
    principals,
    secretHosts,
    connectionProviders: providers,
  });
  return probe(host);
};
