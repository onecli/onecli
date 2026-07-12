import { apiGet, apiPut } from "./client";
import type { ProjectAccessBindings, SetProjectAccessInput } from "./types";

export const list = (projectId: string) =>
  apiGet<ProjectAccessBindings>(`/v1/projects/${projectId}/access`);

export const set = (projectId: string, input: SetProjectAccessInput) =>
  apiPut<{ added: number; removed: number; roleChanged: number }>(
    `/v1/projects/${projectId}/access`,
    input,
  );
