import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./oauth/google";

export const googleContacts: AppDefinition = {
  id: "google-contacts",
  name: "Google Contacts",
  icon: "/icons/google-contacts.svg",
  description: "Read, search, and manage Google Contacts.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/contacts.readonly",
        name: "Read contacts",
        description: "View your contacts",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/contacts",
        name: "Manage contacts",
        description: "Create, update, and delete contacts",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/contacts.other.readonly",
        name: "Read other contacts",
        description:
          "View 'other contacts' — auto-saved people you've emailed but not added",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/directory.readonly",
        name: "Read directory",
        description: "View your organization's directory of coworkers",
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
