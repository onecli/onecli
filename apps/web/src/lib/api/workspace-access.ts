import { apiGet, apiPut } from "./client";
import type { WorkspaceAccessBindings, SetWorkspaceAccessInput } from "./types";

export const list = (workspaceId: string) =>
  apiGet<WorkspaceAccessBindings>(`/v1/workspaces/${workspaceId}/access`);

export const set = (workspaceId: string, input: SetWorkspaceAccessInput) =>
  apiPut<{ added: number; removed: number; roleChanged: number }>(
    `/v1/workspaces/${workspaceId}/access`,
    input,
  );
