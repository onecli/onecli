export type {
  AppTool,
  AppToolGroup,
  AppPermissionLevel,
  AppPermissionDefinition,
} from "./types";
export { mapRuleActionToPermission, allGroupTools } from "./types";

import type { AppPermissionDefinition } from "./types";
import { awsPermissions } from "./aws";
import { cloudflarePermissions } from "./cloudflare";
import { confluencePermissions } from "./confluence";
import { dockerPermissions } from "./docker";
import { flyioPermissions } from "./flyio";
import { dropboxPermissions } from "./dropbox";
import { githubPermissions, githubAppPermissions } from "./github";
import { gitlabPermissions } from "./gitlab";
import { gmailPermissions } from "./gmail";
import { googleAdminPermissions } from "./google-admin";
import { googleAnalyticsPermissions } from "./google-analytics";
import { googleCalendarPermissions } from "./google-calendar";
import { googleChatPermissions } from "./google-chat";
import { googleClassroomPermissions } from "./google-classroom";
import { googleDocsPermissions } from "./google-docs";
import { googleDrivePermissions } from "./google-drive";
import { googleFormsPermissions } from "./google-forms";
import { googleMeetPermissions } from "./google-meet";
import { googlePhotosPermissions } from "./google-photos";
import { googleSearchConsolePermissions } from "./google-search-console";
import { googleSheetsPermissions } from "./google-sheets";
import { googleSlidesPermissions } from "./google-slides";
import { googleTasksPermissions } from "./google-tasks";
import { jiraPermissions } from "./jira";
import { mongodbAtlasPermissions } from "./mongodb-atlas";
import { notionPermissions } from "./notion";
import { supabasePermissions } from "./supabase";
import { resendPermissions } from "./resend";
import { todoistPermissions } from "./todoist";
import { vertexAiPermissions } from "./vertex-ai";
import { youtubePermissions } from "./youtube";
import { linkedinPermissions } from "./linkedin";
import { trelloPermissions } from "./trello";
import { mondayPermissions } from "./monday";
import { vercelPermissions } from "./vercel";

const permissionRegistry = new Map<string, AppPermissionDefinition>();

const register = (def: AppPermissionDefinition) => {
  permissionRegistry.set(def.provider, def);
};

export const getAppPermissionDefinition = (
  provider: string,
): AppPermissionDefinition | undefined => permissionRegistry.get(provider);

export const registerAppPermission = register;

register(awsPermissions);
register(cloudflarePermissions);
register(gmailPermissions);
register(githubPermissions);
register(githubAppPermissions);
register(gitlabPermissions);
register(googleDrivePermissions);
register(googleCalendarPermissions);
register(googleChatPermissions);
register(googleSheetsPermissions);
register(googleDocsPermissions);
register(googleSlidesPermissions);
register(googleAdminPermissions);
register(googleAnalyticsPermissions);
register(googleClassroomPermissions);
register(googleFormsPermissions);
register(googleMeetPermissions);
register(googlePhotosPermissions);
register(googleSearchConsolePermissions);
register(googleTasksPermissions);
register(youtubePermissions);
register(jiraPermissions);
register(confluencePermissions);
register(dockerPermissions);
register(resendPermissions);
register(todoistPermissions);
register(vertexAiPermissions);
register(mongodbAtlasPermissions);
register(notionPermissions);
register(flyioPermissions);
register(dropboxPermissions);
register(supabasePermissions);
register(linkedinPermissions);
register(trelloPermissions);
register(mondayPermissions);
register(vercelPermissions);
