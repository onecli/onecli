import type { AppPermissionDefinition, AppTool } from "./types";

// Twilio REST APIs (twilio.com/docs/usage/api). Each product has its own host
// (`api.twilio.com` for the 2010 core API, `verify.twilio.com`, …), and each
// answers in the IE1 and AU1 regions too, under `<product>.<edge>.<region>`.
// Every tool lists all three: the gateway routes a connection to its own
// region (see the gateway host rewrite), so whichever host the agent called,
// the rule that governs it is the same.
//
// The core API puts the account first: `/2010-04-01/Accounts/{AccountSid}/…`.
// `*` in that slot matches the Account SID or a subaccount's. Single-item
// paths end in `*.json`: one segment exactly, never deeper.
//
// Sending a message or placing a call reaches real people and costs money,
// so those are writes of their own. Phone-number purchases and releases too.
//
// Reading an account (`/Accounts/{sid}.json`, `/Accounts.json`) is not a
// tool on purpose: Twilio's answer carries the account's Auth Token (and each
// subaccount's), the master credential. Left unlisted, it needs approval
// under every default grant instead of riding along with the read tools.
const REGIONAL = (product: string): [string, string[]] => [
  `${product}.twilio.com`,
  [`${product}.dublin.ie1.twilio.com`, `${product}.sydney.au1.twilio.com`],
];

const tool = (
  product: string,
  id: string,
  name: string,
  description: string,
  pathPattern: string,
  methods: string[],
  aliasPatterns?: string[],
): AppTool => {
  const [hostPattern, hostAliasPatterns] = REGIONAL(product);
  return {
    id,
    name,
    description,
    hostPattern,
    hostAliasPatterns,
    pathPattern,
    ...(aliasPatterns ? { aliasPatterns } : {}),
    ...(methods.length === 1 ? { method: methods[0] } : { methods }),
  };
};

const ACCT = "/2010-04-01/Accounts/*";

export const twilioPermissions: AppPermissionDefinition = {
  provider: "twilio",
  groups: [
    {
      category: "read",
      tools: [
        tool(
          "api",
          "read_messages",
          "Read messages",
          "List and read SMS, MMS, and WhatsApp messages, and their media",
          `${ACCT}/Messages.json`,
          ["GET"],
          [`${ACCT}/Messages/*`],
        ),
        tool(
          "api",
          "read_calls",
          "Read calls",
          "List and read calls, their recordings, and notifications",
          `${ACCT}/Calls.json`,
          ["GET"],
          [
            `${ACCT}/Calls/*`,
            `${ACCT}/Recordings.json`,
            `${ACCT}/Recordings/*`,
          ],
        ),
        tool(
          "api",
          "read_phone_numbers",
          "Read phone numbers",
          "List the account's phone numbers and caller IDs, and search numbers available to buy",
          `${ACCT}/IncomingPhoneNumbers.json`,
          ["GET"],
          [
            `${ACCT}/IncomingPhoneNumbers/*`,
            `${ACCT}/OutgoingCallerIds.json`,
            `${ACCT}/AvailablePhoneNumbers.json`,
            `${ACCT}/AvailablePhoneNumbers/*`,
          ],
        ),
        tool(
          "api",
          "read_usage",
          "Read balance and usage",
          "Read the account balance and usage records",
          `${ACCT}/Balance.json`,
          ["GET"],
          [`${ACCT}/Usage/*`],
        ),
        tool(
          "lookups",
          "lookup_phone_number",
          "Look up a phone number",
          "Validate and format a phone number, and read its carrier and line type",
          "/v2/PhoneNumbers/*",
          ["GET"],
        ),
        tool(
          "messaging",
          "read_messaging_services",
          "Read messaging services",
          "List messaging services and their senders",
          "/v1/Services",
          ["GET"],
          ["/v1/Services/*"],
        ),
        tool(
          "verify",
          "read_verify_services",
          "Read verify services",
          "List verification services and read a verification's status",
          "/v2/Services",
          ["GET"],
          ["/v2/Services/*"],
        ),
        tool(
          "conversations",
          "read_conversations",
          "Read conversations",
          "List conversations and read their messages and participants",
          "/v1/Conversations",
          ["GET"],
          ["/v1/Conversations/*", "/v1/Services/*"],
        ),
      ],
    },
    {
      category: "write",
      tools: [
        tool(
          "api",
          "send_message",
          "Send a message",
          "Send an SMS, MMS, or WhatsApp message to a phone number",
          `${ACCT}/Messages.json`,
          ["POST"],
        ),
        tool(
          "api",
          "manage_messages",
          "Update or delete messages",
          "Cancel a scheduled message, redact a message body, or delete a message and its media",
          `${ACCT}/Messages/*`,
          ["POST", "DELETE"],
        ),
        tool(
          "api",
          "place_call",
          "Place a call",
          "Start an outbound phone call",
          `${ACCT}/Calls.json`,
          ["POST"],
        ),
        tool(
          "api",
          "manage_calls",
          "Update or delete calls",
          "Redirect or end a live call, or delete a call record or recording",
          `${ACCT}/Calls/*`,
          ["POST", "DELETE"],
          [`${ACCT}/Recordings/*`],
        ),
        tool(
          "api",
          "manage_phone_numbers",
          "Buy, configure, or release phone numbers",
          "Buy a phone number, change its webhooks, or release it",
          `${ACCT}/IncomingPhoneNumbers.json`,
          ["POST", "DELETE"],
          [`${ACCT}/IncomingPhoneNumbers/*`],
        ),
        tool(
          "verify",
          "send_verification",
          "Send a verification code",
          "Send a one-time code by SMS, WhatsApp, voice, or email, and check it",
          "/v2/Services/*/Verifications",
          ["POST"],
          ["/v2/Services/*/VerificationCheck"],
        ),
        tool(
          "verify",
          "update_verification",
          "Approve or cancel a verification",
          "Mark a verification approved without its code, or cancel it",
          "/v2/Services/*/Verifications/*",
          ["POST"],
        ),
        tool(
          "verify",
          "manage_verify_services",
          "Manage verify services",
          "Create, update, or delete verification services",
          "/v2/Services",
          ["POST", "DELETE"],
          ["/v2/Services/*/"],
        ),
        tool(
          "messaging",
          "manage_messaging_services",
          "Manage messaging services",
          "Create, update, or delete messaging services and their senders",
          "/v1/Services",
          ["POST", "DELETE"],
          ["/v1/Services/*"],
        ),
        tool(
          "conversations",
          "manage_conversations",
          "Send and manage conversations",
          "Create conversations, add participants, and send conversation messages",
          "/v1/Conversations",
          ["POST", "DELETE"],
          ["/v1/Conversations/*", "/v1/Services/*"],
        ),
      ],
    },
  ],
};
