import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./oauth/google";

export const googleSheets: AppDefinition = {
  id: "google-sheets",
  name: "Google Sheets",
  icon: "/icons/google-sheets.svg",
  description: "Read, create, and edit spreadsheets.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
        name: "Read spreadsheets",
        description: "View all your Google Sheets spreadsheets",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/spreadsheets",
        name: "Edit spreadsheets",
        description: "Create and edit all your Google Sheets spreadsheets",
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
