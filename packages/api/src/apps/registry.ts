import type { AppDefinition } from "./types";
import { getCloudApps } from "../providers";
import { confluence } from "./confluence";
import { github } from "./github";
import { githubApp } from "./github-app";
import { gmail } from "./gmail";
import { jira } from "./jira";
import { googleAdmin } from "./google-admin";
import { googleAnalytics } from "./google-analytics";
import { googleCalendar } from "./google-calendar";
import { googleClassroom } from "./google-classroom";
import { googleDocs } from "./google-docs";
import { googleDrive } from "./google-drive";
import { googleForms } from "./google-forms";
import { googleMeet } from "./google-meet";
import { googlePhotos } from "./google-photos";
import { googleSearchConsole } from "./google-search-console";
import { googleSheets } from "./google-sheets";
import { googleSlides } from "./google-slides";
import { googleTasks } from "./google-tasks";
import { mongodbAtlas } from "./mongodb-atlas";
import { notion } from "./notion";
import { resend } from "./resend";
import { todoist } from "./todoist";
import { vertexAi } from "./vertex-ai";
import { youtube } from "./youtube";
import { cloudflare } from "./cloudflare";
import { aws } from "./aws";

const staticApps: AppDefinition[] = [
  gmail,
  github,
  githubApp,
  googleDrive,
  googleCalendar,
  resend,
  googleAdmin,
  googleAnalytics,
  googleClassroom,
  googleDocs,
  googleForms,
  googleMeet,
  googlePhotos,
  googleSearchConsole,
  googleSheets,
  googleSlides,
  googleTasks,
  notion,
  jira,
  confluence,
  youtube,
  vertexAi,
  todoist,
  cloudflare,
  aws,
  mongodbAtlas,
];

export const getApps = (): AppDefinition[] => [
  ...staticApps,
  ...getCloudApps(),
];

export const getApp = (id: string): AppDefinition | undefined =>
  getApps().find((app) => app.id === id);
