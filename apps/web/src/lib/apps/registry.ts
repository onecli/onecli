import type { AppDefinition } from "./types";
import { github } from "./github";
import { google } from "./google";
import { resend } from "./resend";

export const apps: AppDefinition[] = [github, google, resend];

export const getApp = (id: string): AppDefinition | undefined =>
  apps.find((app) => app.id === id);
