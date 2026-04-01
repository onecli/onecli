import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./google-oauth";

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
