import { apiPatch, apiDelete } from "./client";
import type { Project } from "./types";

export const rename = (id: string, name: string) =>
  apiPatch<Project>(`/v1/projects/${id}`, { name });

export const remove = (id: string) => apiDelete(`/v1/projects/${id}`);
