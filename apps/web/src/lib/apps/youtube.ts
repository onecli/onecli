import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./google-oauth";

export const youtube: AppDefinition = {
  id: "youtube",
  name: "YouTube",
  icon: "/icons/youtube.svg",
  description: "Manage playlists, videos, and channel content on YouTube.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        name: "View YouTube",
        description: "View your account, videos, and playlists",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/youtube",
        name: "Manage YouTube",
        description: "Create, edit, and delete playlists and videos",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        name: "Manage comments",
        description: "View and manage comments and captions on videos",
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
