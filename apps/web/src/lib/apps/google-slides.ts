import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./google-oauth";

export const googleSlides: AppDefinition = {
  id: "google-slides",
  name: "Google Slides",
  icon: "/icons/google-slides.svg",
  description: "Read, create, and edit presentations.",
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
        name: "Read presentations",
        description: "View all your Google Slides",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/drive.file",
        name: "Manage app presentations",
        description:
          "Create and edit presentations opened or created by OneCLI",
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
