import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./oauth/google";

export const googleDrive: AppDefinition = {
  id: "google-drive",
  name: "Google Drive",
  icon: "/icons/google-drive.svg",
  description: "Read, create, and manage files and folders.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/drive.readonly",
        name: "Read files",
        description: "View and download all your Drive files",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/drive",
        name: "Manage files",
        description: "Create, edit, move, and delete all your Drive files",
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
