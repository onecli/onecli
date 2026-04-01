import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./google-oauth";

export const googleTasks: AppDefinition = {
  id: "google-tasks",
  name: "Google Tasks",
  icon: "/icons/google-tasks.svg",
  description: "Manage task lists and tasks.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/tasks",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/tasks",
        name: "Tasks",
        description: "Read, create, and manage task lists and tasks",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.email",
        name: "Email address",
        description: "View your email address",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.profile",
        name: "Profile",
        description: "Name and profile picture",
        access: "read",
      },
    ],
    buildAuthUrl: buildGoogleAuthUrl,
    exchangeCode: exchangeGoogleCode,
  },
  available: true,
  configurable: {
    fields: googleConfigFields,
  },
};
