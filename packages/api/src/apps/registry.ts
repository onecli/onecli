import type { AppDefinition } from "./types";
// This registry is CLIENT-SAFE: it is imported by client components, so it —
// and every definition it pulls in — must stay free of Node builtins (OAuth
// handlers that need them load them lazily via `await import("node:...")`).
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
import { googleContacts } from "./google-contacts";
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
import { datadog } from "./datadog";
import { outlookMail } from "./outlook-mail";
import { outlookCalendar } from "./outlook-calendar";
import { microsoftWord } from "./microsoft-word";
import { microsoftOnenote } from "./microsoft-onenote";
import { awsRole } from "./aws-role";
import { affinity } from "./affinity";
import { zoom } from "./zoom";
import { sentry } from "./sentry";
import { granola } from "./granola";
import { hubspot } from "./hubspot";
import { linear } from "./linear";
import { attio } from "./attio";
import { x } from "./x";
import { fathom } from "./fathom";
import { slack } from "./slack";
import { fireflies } from "./fireflies";
import { zohoCrm } from "./zoho-crm";
import { snowflake } from "./snowflake";
import { stripe } from "./stripe";

const staticApps: AppDefinition[] = [
  gmail,
  github,
  githubApp,
  gitlab,
  googleDrive,
  googleCalendar,
  googleChat,
  googleContacts,
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
  datadog,
  outlookMail,
  outlookCalendar,
  microsoftWord,
  microsoftOnenote,
  awsRole,
  affinity,
  zoom,
  sentry,
  hubspot,
  granola,
  linear,
  attio,
  x,
  fathom,
  slack,
  fireflies,
  zohoCrm,
  snowflake,
  stripe,
];

export const getApps = (): AppDefinition[] => [...staticApps];

export const getApp = (id: string): AppDefinition | undefined =>
  getApps().find((app) => app.id === id);
