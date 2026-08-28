import type { AppDefinition } from "./types";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  microsoftConfigFields,
  microsoftEnvDefaults,
} from "./oauth/microsoft";

export const microsoftOnenote: AppDefinition = {
  id: "microsoft-onenote",
  name: "Microsoft OneNote",
  icon: "/icons/microsoft-onenote.svg",
  description:
    "Read and manage notebooks, sections, and pages in Microsoft OneNote.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Notes.Read",
      "Notes.ReadWrite",
      "Notes.Create",
    ],
    permissions: [
      {
        scope: "Notes.Read",
        name: "Read notebooks",
        description: "View your OneNote notebooks, sections, and pages",
        access: "read",
      },
      {
        scope: "Notes.ReadWrite",
        name: "Read & write notebooks",
        description: "View, create, and edit notebooks, sections, and pages",
        access: "write",
      },
      {
        scope: "Notes.Create",
        name: "Create pages",
        description: "Create new pages in your OneNote notebooks",
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
