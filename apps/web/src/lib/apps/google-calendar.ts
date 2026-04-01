import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./google-oauth";

export const googleCalendar: AppDefinition = {
  id: "google-calendar",
  name: "Google Calendar",
  icon: "/icons/google-calendar.svg",
  description: "Read, create, and manage calendar events.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        name: "Read calendars",
        description: "View calendars and events",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/calendar.events",
        name: "Manage events",
        description: "Create, edit, and delete events on your calendars",
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
    envDefaults: googleEnvDefaults,
  },
};
