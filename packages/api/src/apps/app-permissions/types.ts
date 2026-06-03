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

export const allGroupTools = (group: AppToolGroup): AppTool[] => [
  ...(group.wildcard ? [group.wildcard] : []),
  ...group.tools,
];

export type AppPermissionLevel = "allow" | "manual_approval" | "block";

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
