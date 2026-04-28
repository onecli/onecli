import type { AppDefinition } from "./types";
import { confluence } from "./confluence";
import { github } from "./github";
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
import { resend } from "./resend";
import { youtube } from "./youtube";

export const apps: AppDefinition[] = [
  gmail,
  github,
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
  jira,
  confluence,
  youtube,
];

export const getApp = (id: string): AppDefinition | undefined =>
  apps.find((app) => app.id === id);
