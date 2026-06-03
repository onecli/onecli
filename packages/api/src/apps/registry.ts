import type { AppDefinition } from "./types";
import { getCloudApps } from "../providers";
import { IS_CLOUD } from "../lib/env";
import { confluence } from "./confluence";
import { docker } from "./docker";
import { github } from "./github";
import { githubApp } from "./github-app";
import { gitlab } from "./gitlab";
import { gmail } from "./gmail";
import { jira } from "./jira";
import { googleAdmin } from "./google-admin";
import { googleAnalytics } from "./google-analytics";
import { googleCalendar } from "./google-calendar";
import { googleChat } from "./google-chat";
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
import { flyio } from "./flyio";
import { dropbox } from "./dropbox";
import { supabase } from "./supabase";
import { aws } from "./aws";
import { linkedin } from "./linkedin";
import { trello } from "./trello";
import { monday } from "./monday";
import { vercel } from "./vercel";
import { jfrogArtifactory } from "./jfrog-artifactory";

const staticApps: AppDefinition[] = [
  gmail,
  github,
  githubApp,
  gitlab,
  googleDrive,
  googleCalendar,
  googleChat,
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
  docker,
  youtube,
  vertexAi,
  todoist,
  cloudflare,
  flyio,
  dropbox,
  aws,
  monday,
  mongodbAtlas,
  supabase,
  linkedin,
  trello,
  vercel,
  jfrogArtifactory,
];

const CLOUD_HIDDEN_APPS = new Set(["jfrog-artifactory"]);

export const getApps = (): AppDefinition[] => {
  const apps = [...staticApps, ...getCloudApps()];
  return IS_CLOUD ? apps.filter((a) => !CLOUD_HIDDEN_APPS.has(a.id)) : apps;
};

export const getApp = (id: string): AppDefinition | undefined =>
  getApps().find((app) => app.id === id);
