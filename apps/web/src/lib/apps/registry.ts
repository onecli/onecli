import type { AppDefinition } from "./types";
import { github } from "./github";
import { google } from "./google";

export const apps: AppDefinition[] = [github, google];

export const getApp = (id: string): AppDefinition | undefined =>
  apps.find((app) => app.id === id);
