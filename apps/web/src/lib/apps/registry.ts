import type { AppDefinition } from "./types";
import { github } from "./github";

export const apps: AppDefinition[] = [github];

export const getApp = (id: string): AppDefinition | undefined =>
  apps.find((app) => app.id === id);
