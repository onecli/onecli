import type { AppDefinition } from "./types";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  microsoftConfigFields,
  microsoftEnvDefaults,
} from "./oauth/microsoft";

export const microsoft365: AppDefinition = {
  id: "microsoft-365",
  name: "Microsoft 365",
  icon: "/icons/microsoft-365.svg",
  description:
    "Read and send Outlook email and manage calendar events via Microsoft 365.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
    ],
    permissions: [
      {
        scope: "Mail.ReadWrite",
        name: "Read and manage emails",
        description: "Read, draft, and organize your Outlook email",
        access: "write",
      },
      {
        scope: "Mail.Send",
        name: "Send emails",
        description: "Send email on your behalf",
        access: "write",
      },
      {
        scope: "Calendars.ReadWrite",
        name: "Manage calendar",
        description: "View, create, and update calendar events",
        access: "write",
      },
      {
        scope: "User.Read",
        name: "Profile",
        description: "Name and email address",
        access: "read",
      },
    ],
    buildAuthUrl: buildMicrosoftAuthUrl,
    exchangeCode: exchangeMicrosoftCode,
  },
  available: true,
  configurable: {
    fields: microsoftConfigFields,
    envDefaults: microsoftEnvDefaults,
    hint: "Use credentials from an Azure App Registration (common tenant)",
  },
};
