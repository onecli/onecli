import type { AppDefinition } from "./types";
import { github } from "./github";
import { gmail } from "./gmail";
import { googleCalendar } from "./google-calendar";
import { resend } from "./resend";

export const apps: AppDefinition[] = [github, gmail, googleCalendar, resend];

export const getApp = (id: string): AppDefinition | undefined =>
  apps.find((app) => app.id === id);
