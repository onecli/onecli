import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./google-oauth";

export const gmail: AppDefinition = {
  id: "gmail",
  name: "Gmail",
  icon: "/icons/gmail.svg",
  description: "Read, compose, and send emails via Gmail.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        name: "Read emails",
        description: "View your email messages and settings",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/gmail.modify",
        name: "Manage emails",
        description: "Read, draft, and organize email and labels",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/gmail.send",
        name: "Send emails",
        description: "Send email on your behalf",
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
