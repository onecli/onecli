export interface AppTool {
  id: string;
  name: string;
  description: string;
  hostPattern: string;
  pathPattern: string;
  method?: string;
}

export interface AppToolGroup {
  category: "read" | "write";
  tools: AppTool[];
}

export type AppPermissionLevel = "allow" | "manual_approval" | "block";

export interface AppPermissionDefinition {
  provider: string;
  groups: AppToolGroup[];
}
