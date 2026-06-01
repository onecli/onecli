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
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/documents",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/documents.readonly",
        name: "Read documents",
        description: "View all your Google Docs",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/documents",
        name: "Edit documents",
        description: "Create and edit all your Google Docs",
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
