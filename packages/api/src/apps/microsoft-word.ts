import type { AppDefinition } from "./types";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  microsoftConfigFields,
  microsoftEnvDefaults,
} from "./oauth/microsoft";

export const microsoftWord: AppDefinition = {
  id: "microsoft-word",
  name: "Microsoft Word",
  apiDocsUrl:
    "https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0",
  icon: "/icons/microsoft-word.svg",
  description:
    "Read and edit Word documents stored in OneDrive and SharePoint.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Files.ReadWrite",
    ],
    permissions: [
      {
        scope: "Files.ReadWrite",
        name: "Read & edit files",
        description:
          "View, create, update, and delete files in OneDrive and SharePoint",
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
