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
    ...(group.wildcard ? { wildcard: toToolSummary(group.wildcard) } : {}),
  })),
});
