import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./oauth/google";

export const googleDocs: AppDefinition = {
  id: "google-docs",
  name: "Google Docs",
  icon: "/icons/google-docs.svg",
  description: "Read, create, and edit Google Docs documents.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/documents",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/drive.readonly",
        name: "Read documents",
        description: "View all your Google Docs",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/drive.file",
        name: "Manage app documents",
        description: "Create and edit documents opened or created by OneCLI",
        access: "write",
      },
      {
        // drive.file only covers files OneCLI created or opened via a picker,
        // so without this an agent can read a user's existing doc but its
        // batchUpdate gets a 403 from Google.
        scope: "https://www.googleapis.com/auth/documents",
        name: "Edit documents",
        description: "Edit all your Google Docs documents",
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
  configurable: {
    fields: googleConfigFields,
  },
};
