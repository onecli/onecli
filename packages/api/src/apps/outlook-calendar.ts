import type { AppDefinition } from "./types";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  microsoftConfigFields,
  microsoftEnvDefaults,
} from "./oauth/microsoft";

export const outlookCalendar: AppDefinition = {
  id: "outlook-calendar",
  name: "Outlook Calendar",
  icon: "/icons/outlook-calendar.svg",
  description: "View and manage calendar events in Microsoft Outlook.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Calendars.ReadWrite",
    ],
    permissions: [
      {
        scope: "Calendars.ReadWrite",
        name: "Read & manage calendars",
        description: "View, create, update, and delete calendar events",
        access: "write",
      },
      {
        scope: "User.Read",
        name: "Profile",
        description: "Your name and email address",
        access: "read",
      },
    ],
    buildAuthUrl: buildMicrosoftAuthUrl,
    exchangeCode: exchangeMicrosoftCode,
  },
  configurable: {
    fields: microsoftConfigFields,
    envDefaults: microsoftEnvDefaults,
  },
};
