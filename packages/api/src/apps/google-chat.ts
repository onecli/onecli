import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./oauth/google";

export const googleChat: AppDefinition = {
  id: "google-chat",
  name: "Google Chat",
  icon: "/icons/google-chat.svg",
  description: "Send messages and manage spaces in Google Chat.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/chat.spaces",
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/chat.memberships",
      "https://www.googleapis.com/auth/chat.memberships.readonly",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/chat.spaces",
        name: "Manage spaces",
        description: "Create and manage Chat spaces",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/chat.spaces.readonly",
        name: "Read spaces",
        description: "View Chat spaces and their details",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/chat.messages",
        name: "Manage messages",
        description: "Send, edit, and delete messages in Chat",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/chat.messages.readonly",
        name: "Read messages",
        description: "View messages in Chat spaces",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/chat.memberships",
        name: "Manage memberships",
        description: "Add and remove members from Chat spaces",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/chat.memberships.readonly",
        name: "Read memberships",
        description: "View members of Chat spaces",
        access: "read",
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
