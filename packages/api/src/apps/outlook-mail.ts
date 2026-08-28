import type { AppDefinition } from "./types";
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  microsoftConfigFields,
  microsoftEnvDefaults,
} from "./oauth/microsoft";

export const outlookMail: AppDefinition = {
  id: "outlook-mail",
  name: "Outlook Mail",
  icon: "/icons/outlook-mail.svg",
  description: "Read, compose, and send emails via Microsoft Outlook.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ],
    permissions: [
      {
        scope: "Mail.ReadWrite",
        name: "Read & manage emails",
        description: "View, create, update, and organize email messages",
        access: "write",
      },
      {
        scope: "Mail.Send",
        name: "Send emails",
        description: "Send email on your behalf",
        access: "write",
      },
      {
        scope: "User.Read",
        name: "Profile",
        description: "Your name and email address",
        access: "read",
      },
    ],
    buildAuthUrl: buildMicrosoftAuthUrl,
    exchangeCode: exchangeMicrosoftCode,
  },
  configurable: {
    fields: microsoftConfigFields,
    envDefaults: microsoftEnvDefaults,
  },
};
