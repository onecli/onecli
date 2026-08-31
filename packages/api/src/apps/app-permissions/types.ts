export interface AppTool {
  id: string;
  name: string;
  description: string;
  hostPattern: string;
  /**
   * Additional host patterns this tool ALSO answers on — the host-axis twin of
   * `aliasPatterns`. Both ports match when the request host matches
   * `hostPattern` OR any entry here (see `hostPatternsOf`).
   *
   * Why: `hostMatches` supports a SINGLE `*` (a prefix/suffix split, pinned by
   * `path-match.test.ts`), yet one API surface legitimately answers on several
   * host shapes no single pattern can express together — AWS S3 serves the
   * global `s3.amazonaws.com` AND the regional `s3.<region>.amazonaws.com`.
   * Enumerating the shapes keeps every pattern narrow and explicit instead of
   * widening the matcher (shared with secret targets and injection) or
   * reaching for a loose glob like `s3*.amazonaws.com`, which would also
   * swallow the SEPARATE `s3tables.*` / `s3-control.*` services — i.e. grant
   * across a service boundary.
   *
   * Each entry is an ordinary pattern subject to the SAME single-`*` rule, so
   * the permit surface is exactly what is written. A pattern with two or more
   * `*` matches NOTHING (the second `*` becomes a literal in the suffix), so
   * it would fail closed but silently — `catalog-json.test.ts` rejects those
   * at authoring time rather than letting a dead pattern ship.
   */
  hostAliasPatterns?: string[];
  pathPattern: string;
  aliasPatterns?: string[];
  method?: string;
  methods?: string[];
  /**
   * GraphQL operation discrimination for tools sharing one `POST /graphql`
   * endpoint. When set, the tool matches a request only if the buffered body
   * classifies to this operation kind - with the FAIL-CLOSED law shared by
   * both ports (TS `classifyGraphqlBody` / Rust `graphql.rs`): a missing,
   * truncated, or unparsable body, or a document containing ANY non-query
   * operation, classifies as `mutation`. So a `mutation`-tagged tool matches
   * every doubtful request (a block on it always holds), and a `query`-tagged
   * tool matches only a provably pure query document (an allow on it can
   * never smuggle a mutation). Tools without this field are unaffected.
   */
  graphqlOps?: "query" | "mutation";
}

export interface AppToolGroup {
  category: "read" | "write";
  tools: AppTool[];
  wildcard?: AppTool;
}

export const allGroupTools = <T>(group: { tools: T[]; wildcard?: T }): T[] => [
  ...(group.wildcard ? [group.wildcard] : []),
  ...group.tools,
];

const methodsOf = (tool: AppTool): string[] =>
  tool.methods ?? (tool.method ? [tool.method] : []);

/**
 * Every host pattern a tool matches on: its primary plus any
 * `hostAliasPatterns`. The single source of the host axis — the TS matchers
 * and the generated gateway JSON both derive from this, so the two ports can
 * never disagree about which hosts a tool covers.
 */
export const hostPatternsOf = (tool: AppTool): string[] => [
  tool.hostPattern,
  ...(tool.hostAliasPatterns ?? []),
];

// The gateway treats a pattern ending in "*" as a prefix match; tool patterns
// reuse the wildcard's leading "*" segments verbatim, so comparing the literal
// text before the trailing "*" with `startsWith` mirrors the matcher — and
// fails closed (a tool that doesn't share the prefix is simply not covered).
const prefixOf = (pattern: string): string =>
  pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;

/**
 * Is a group's `wildcard` a TRUE superset of every tool in the group — hosts,
 * a path prefix covering each tool's paths (+ aliases), and a method set
 * containing each tool's methods? Only then does the "All read/write
 * operations" umbrella genuinely mean "all of them". Some read wildcards are
 * NOT supersets (e.g. Jira's `read_all` is GET-only but JQL search is POST;
 * Confluence's search lives on a different path prefix), so the tools picker
 * offers the umbrella only where this returns true — an incomplete umbrella
 * would author a misleading "all reads" that silently misses those endpoints.
 * Mirrors the coverage check pinned by `write-wildcard-coverage.test.ts`.
 */
export const wildcardCoversGroup = (
  wildcard: AppTool,
  tools: AppTool[],
): boolean => {
  const prefixes = [
    wildcard.pathPattern,
    ...(wildcard.aliasPatterns ?? []),
  ].map(prefixOf);
  const wildcardMethods = methodsOf(wildcard);
  // Host axis is SET containment, not equality: a tool is covered only when
  // every host it answers on is also a host the wildcard answers on. Comparing
  // primaries alone would call an umbrella "complete" while a tool's alias host
  // sat outside it — the misleading "all reads" this guard exists to reject.
  const wildcardHosts = new Set(hostPatternsOf(wildcard));
  return tools.every(
    (tool) =>
      hostPatternsOf(tool).every((host) => wildcardHosts.has(host)) &&
      [tool.pathPattern, ...(tool.aliasPatterns ?? [])].every((pattern) =>
        prefixes.some((prefix) => pattern.startsWith(prefix)),
      ) &&
      methodsOf(tool).every((method) => wildcardMethods.includes(method)),
  );
};

export type AppPermissionLevel = "allow" | "manual_approval" | "block";

/**
 * A permission setting for one layer of app rules. "inherit" is only valid for
 * agent-scoped layers: it removes the agent's rows so the tool falls back to
 * the all-agents setting.
 */
export type AppPermissionSetting = AppPermissionLevel | "inherit";

export const mapRuleActionToPermission = (
  action: string,
): AppPermissionLevel =>
  action === "block"
    ? "block"
    : action === "allow"
      ? "allow"
      : "manual_approval";

export interface AppPermissionDefinition {
  provider: string;
  groups: AppToolGroup[];
}

// The public projection of the catalog: tool identity only. The endpoint
// mapping (hostPattern/pathPattern/method/aliasPatterns) is server-internal
// and must never be serialized into an API response or a client bundle.
export interface AppToolSummary {
  id: string;
  name: string;
  description: string;
}

export interface AppToolGroupSummary {
  category: "read" | "write";
  tools: AppToolSummary[];
  wildcard?: AppToolSummary;
  /** Whether `wildcard` is a true superset of the group's tools (see
   * {@link wildcardCoversGroup}) — computed server-side, where the endpoint
   * patterns live. The tools picker offers the umbrella only when true; absent
   * when the group has no wildcard. */
  wildcardComplete?: boolean;
}

export interface AppPermissionDefinitionSummary {
  provider: string;
  groups: AppToolGroupSummary[];
}

const toToolSummary = ({ id, name, description }: AppTool): AppToolSummary => ({
  id,
  name,
  description,
});

export const toAppPermissionDefinitionSummary = (
  def: AppPermissionDefinition,
): AppPermissionDefinitionSummary => ({
  provider: def.provider,
  groups: def.groups.map((group) => ({
    category: group.category,
    tools: group.tools.map(toToolSummary),
    ...(group.wildcard
      ? {
          wildcard: toToolSummary(group.wildcard),
          wildcardComplete: wildcardCoversGroup(group.wildcard, group.tools),
        }
      : {}),
  })),
});
