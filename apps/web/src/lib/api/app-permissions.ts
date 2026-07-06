import { apiGet } from "./client";
import type { AppPermissionDefinitionSummary } from "@onecli/api/apps/app-permissions/types";

// Global static catalog (public projection: id/name/description per tool) —
// no org twin, no project context required.
export const list = () =>
  apiGet<AppPermissionDefinitionSummary[]>("/v1/apps/permission-definitions");
