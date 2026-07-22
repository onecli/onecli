export interface AppTool {
  id: string;
  name: string;
  description: string;
  hostPattern: string;
  pathPattern: string;
  aliasPatterns?: string[];
  method?: string;
  methods?: string[];
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

// The gateway treats a pattern ending in "*" as a prefix match; tool patterns
// reuse the wildcard's leading "*" segments verbatim, so comparing the literal
// text before the trailing "*" with `startsWith` mirrors the matcher — and
// fails closed (a tool that doesn't share the prefix is simply not covered).
const prefixOf = (pattern: string): string =>
  pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;

/**
 * Is a group's `wildcard` a TRUE superset of every tool in the group — same
 * host, a path prefix covering each tool's paths (+ aliases), and a method set
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
  return tools.every(
    (tool) =>
      tool.hostPattern === wildcard.hostPattern &&
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
