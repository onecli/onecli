import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./google-oauth";

export const googleClassroom: AppDefinition = {
  id: "google-classroom",
  name: "Google Classroom",
  icon: "/icons/google-classroom.svg",
  description: "Manage classes, rosters, and invitations.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/classroom.courses",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/classroom.courses",
        name: "Classroom",
        description: "Manage classes, rosters, and coursework",
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
