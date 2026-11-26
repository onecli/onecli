import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./oauth/google";

export const googleKeep: AppDefinition = {
  id: "google-keep",
  name: "Google Keep",
  apiDocsUrl: "https://developers.google.com/workspace/keep/api/reference/rest",
  icon: "/icons/google-keep.svg",
  description:
    "Read, create, delete, and share notes and lists. Google's API can't edit an existing note.",
  // Google serves the Keep API to Workspace accounts only, and only once an
  // admin has granted the OAuth client the Keep scope through domain-wide
  // delegation. Anyone else gets `400 invalid_scope` on Google's consent page.
  connectNote: {
    text: "Google Workspace accounts only. A Workspace admin must first grant your Google client the Keep scope under domain-wide delegation.",
    fallback:
      "Personal Gmail accounts can't connect: Google doesn't offer them the Keep API.",
  },
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/keep",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/keep",
        name: "Keep",
        description: "Read, create, delete, and share your notes and lists",
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
    group: "google",
  },
};
