import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./oauth/google";

export const googlePhotos: AppDefinition = {
  id: "google-photos",
  setupGuideUrl: "https://onecli.sh/docs/integrations/google-photos",
  name: "Google Photos",
  apiDocsUrl: "https://developers.google.com/photos/library/reference/rest",
  icon: "/icons/google-photos.svg",
  description: "Manage photos, videos, and albums.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/photoslibrary",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/photoslibrary",
        name: "Photos",
        description: "Manage photos, videos, and albums",
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
