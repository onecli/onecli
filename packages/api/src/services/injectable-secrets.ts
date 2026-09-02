import { db, type Prisma } from "@onecli/db";
import { grantedSecretSelection } from "./policy-reflect/injection";
import { loadInjectionRules } from "./policy-simulate/load-rules";
import { resolvePrincipalSet } from "./policy-simulate/principal-set";

/**
 * Which secrets an agent may actually be handed — the gateway's own selection,
 * reproduced.
 *
 * Its own module rather than a corner of the container-config builder because
 * it now has two consumers with opposite directions of dependency: the builder
 * composes a container from it, and `llm-credential-service` answers "which
 * provider does this agent hold a key for" from it. Keeping it here is what
 * stops those two importing each other.
 *
 * The rule that matters is that nothing else may re-derive this. A second
 * opinion about what will inject produces an agent the dashboard calls ready
 * and the gateway 401s.
 */

/**
 * A `where` selecting exactly the secrets this agent can be handed: the
 * org+workspace fenced pool NARROWED to what its published rules grant —
 * specific secret ids plus any whole-level grants. An agent with no grants
 * selects NOTHING, the same fail-closed answer the gateway gives (step 7:
 * every agent is rule-selected; there is no all-mode whole-pool arm).
 *
 * The pool is ANDed in rather than trusted away: the gateway selects by fetching
 * the org/workspace-fenced pool and RETAINING the named ids (`connect.rs`), so a
 * rule naming a foreign secret contributes nothing. Fencing only the RULES would
 * not fence their target ids — write-time validation is a write-path invariant,
 * not a query fence, and these rows were materialized by the retired bridge
 * rather than through it.
 */
export const injectableSecretWhere = async (
  agent: { id: string },
  workspaceId: string,
  organizationId: string,
): Promise<Prisma.SecretWhereInput> => {
  const [principals, orgRules, workspaceRules] = await Promise.all([
    resolvePrincipalSet(workspaceId, organizationId),
    loadInjectionRules({ scope: "organization", organizationId }, "published"),
    loadInjectionRules({ scope: "workspace", workspaceId }, "published"),
  ]);
  const granted = grantedSecretSelection(
    [...orgRules, ...workspaceRules],
    agent.id,
    principals,
  );

  const pool: Prisma.SecretWhereInput = {
    OR: [{ workspaceId }, { organizationId, scope: "organization" }],
  };
  // Level grants match the secret's own `scope` column, which is what the
  // gateway compares (`selection.secret_scopes.contains(&s.scope)`).
  const arms: Prisma.SecretWhereInput[] = [];
  if (granted.ids.length > 0) arms.push({ id: { in: granted.ids } });
  if (granted.levels.has("workspace")) arms.push({ scope: "workspace" });
  if (granted.levels.has("organization")) arms.push({ scope: "organization" });
  // No grants → match nothing, never the pool.
  if (arms.length === 0) return { id: { in: [] } };
  return { AND: [pool, { OR: arms }] };
};

/**
 * Which secret wins when several of a type are reachable. The gateway merges
 * org → workspace with later injections overriding earlier (`connect.rs`), so
 * the WORKSPACE one is what actually gets injected. Descending `scope` orders
 * "workspace" > "organization", reproducing that — an unordered `findFirst`
 * returns whichever row Postgres reaches first, which can hand the container
 * an org secret's auth mode while the gateway injects the workspace's.
 */
const SCOPE_PRECEDENCE = { scope: "desc" } as const;

/** Pick the secret of `type` this agent would actually be handed: the injectable
 * set, narrowed to the type, resolved in the gateway's precedence order. Both
 * LLM lookups go through here so the ordering can't drift between them. */
export const findInjectableSecretOfType = async <S extends Prisma.SecretSelect>(
  where: Prisma.SecretWhereInput,
  type: string,
  select: S,
) =>
  db.secret.findFirst({
    where: { AND: [where, { type }] },
    select,
    orderBy: SCOPE_PRECEDENCE,
  });
