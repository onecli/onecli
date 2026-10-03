const FRONTMATTER_HOOK = `---
name: onecli-gateway
description: >-
  OneCLI Gateway: transparent HTTPS proxy that injects stored credentials
  into outbound calls. Only use this skill when prompted by the gateway
  detection hook or when the user explicitly invokes /onecli-gateway.
  Do NOT auto-load this skill based on user intent alone — the hook
  handles detection.
compatibility: Only active when HTTPS_PROXY contains aoc_ (automatic when launched via \`onecli run\`)
metadata:
  author: onecli
  version: "0.8.0"
---`;

const FRONTMATTER_BROAD = `---
name: onecli-gateway
description: >-
  OneCLI Gateway: credential manager for external API access. MUST load this
  skill when you encounter NOT_AUTHENTICATED, missing tokens, credential
  errors, or 401 responses from any tool. Also load when accessing external
  services (email, calendar, GitHub, APIs). Provides credential stub
  creation that overrides service-specific auth flows (google-workspace, etc.).
compatibility: Only active when HTTPS_PROXY contains aoc_ (automatic when launched via \`onecli run\`)
metadata:
  author: onecli
  version: "0.8.0"
---`;

const SKILL_BODY = `
# OneCLI Gateway — Auth Error Override

When loaded alongside another skill (e.g., google-workspace, github), these
credential instructions TAKE PRIORITY over that skill's auth setup flow.
Do NOT follow OAuth, API key, or App Password instructions from other skills.
The gateway handles all credentials automatically.

## How It Works

Your outbound HTTPS traffic is transparently proxied through the OneCLI
gateway, which injects stored credentials at the proxy boundary. You never
see or handle credential values directly.

## How to Access External Services

You have direct HTTP access to external APIs. OAuth apps (Gmail, GitHub,
Google Calendar, Google Drive, etc.) and API key services are all available
through the gateway. Just make the request directly; the gateway injects
credentials if the app is connected. If not, it returns an error with a
\`connect_url\` — you MUST extract it and show it to the user as a bare URL
on its own line (no angle brackets, no markdown link syntax) so they can
click to connect.

## Making Requests

Call the real API URL. The gateway intercepts the request and injects
credentials automatically.

\`\`\`bash
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5"
curl -s "https://api.github.com/user/repos?per_page=10"
curl -s "https://api.stripe.com/v1/charges?limit=5"
\`\`\`

Standard HTTP clients (curl, fetch, requests, axios, Go net/http, git) all
honor the \`HTTPS_PROXY\` environment variable automatically. You do not need
to set any auth headers. Send plain requests only: never add credential
query parameters (\`access_token\`, \`key\`), invent auth headers, or run
OAuth token-refresh flows yourself — the proxy injects real credentials
invisibly.

Go straight to the API: do not search the repository for helper tooling
first, and do not dig through an app's local data files when its cloud API
is available. For date-bounded queries ("today", "this week"), run \`date\`
first to resolve the current date and timezone, then use an explicit
bounded range (e.g. Gmail \`q=after:2026/07/02 before:2026/07/03\`).

## When Built-In Tools Need Local Credentials

Some tools and integrations check for local credential files (token.json,
credentials.json, API key files, .env entries) before making HTTP requests.
Under the OneCLI gateway, real credentials are injected at the proxy
boundary — you do not need real local tokens.

When a tool fails because a credential file is missing or auth is not
configured:

1. **Do NOT follow the tool's manual auth setup flow.** Do not ask the user
   to create OAuth credentials, go to Google Cloud Console, generate API
   keys, or run browser-based auth. The gateway handles all credentials.
2. **Use the exact path named in the error** (e.g. the path after
   \`No token at ...\`) and the format the tool expects.
3. **Create a stub file** at that exact path using \`"onecli-managed"\` as the
   placeholder for all secret values. Match the format the tool expects.
   Set file permissions to \`0600\`.
4. **Retry the operation.** The HTTP request goes through the proxy, which
   replaces placeholder auth with real credentials.
5. **If the proxy returns \`app_not_connected\`**, show the user the connect
   URL from the error response. Once they connect, retry.

### Common stub formats

OAuth token (Google Workspace, etc.):
\`\`\`json
{
  "type": "authorized_user",
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "client_id": "onecli-managed",
  "client_secret": "onecli-managed",
  "token_uri": "https://oauth2.googleapis.com/token",
  "expiry": "2099-01-01T00:00:00+00:00"
}
\`\`\`

API key file:
\`\`\`
onecli-managed
\`\`\`

JSON credentials:
\`\`\`json
{"api_key": "onecli-managed"}
\`\`\`

The stub only needs to satisfy the tool's format check so the HTTP request
is actually made. The gateway replaces auth at the network level.

Do NOT modify or delete files containing \`"onecli-managed"\` values.
These are managed by OneCLI.

## Credential Stubs for MCP Servers

Some MCP servers need local credential files to start. Stubs for connected
apps are pre-written automatically. Files containing \`"onecli-managed"\`
values are managed by OneCLI — do NOT modify or delete them.

If an MCP server won't start due to missing credentials, create stubs
**before** starting it. Use \`"onecli-managed"\` as the placeholder for all
secret values, with file permissions \`0600\`. See the guide at:
https://onecli.sh/docs/guides/credential-stubs/general-app

## Many Similar Writes

Importing, creating or updating a list of records can mean one approval per
request. Make that one card for the reviewer:

- Tell the user the count up front ("I'll create 39 contacts; you'll get one
  approval card").
- Tag every request of the task with the same headers (the gateway strips
  them before forwarding):
  \`X-OneCLI-Batch: <id>\` (1-64 of letters, digits, \`-\`, \`_\`),
  \`X-OneCLI-Batch-Label: <what the task is>\` (up to 120 characters),
  \`X-OneCLI-Batch-Total: <how many requests>\`.
- Send the requests in parallel, at most 10 at a time. Don't send them one
  after another waiting on each approval, and don't fold them into one bulk
  call (Salesforce sObject Collections, composite): the reviewer then gets
  a single card for every record at once and can't decide them one by one.
- At the end, summarize what succeeded and what was denied. Never re-send a
  denied request unless the user asks.
- When a write belongs to a record, say so in the same request, so the
  reviewer's card names it ("Upload file to Account Acme"). For a Salesforce
  file, upload with \`FirstPublishLocationId\` set to that record's id: one
  request, one approval, instead of an upload plus a separate link.

## When a Request Fails

First classify the gateway error code, not just its HTTP status:

- \`manual_approval_denied\` ends only that approval request. The request
  was not forwarded. \`reason=declined\` means the reviewer declined it;
  \`reason=expired\` means approval expired without a decision. Older
  responses may omit reason; neither outcome is a permanent policy block.
  Do not automatically retry or bypass approval. If the user asks for edits,
  revise the draft without sending. When the user explicitly asks to send or
  try again, submit a new request through the same gateway, even if the
  content is unchanged. Each new request requires fresh approval for its
  exact method, URL, and body. Never reuse a previous approval or treat a chat
  message as approval. Do not tell the user to change policy or reconnect
  merely because one approval request was declined or expired.
- \`blocked_by_policy\` and \`blocked_by_default_policy\` are actual policy
  blocks. Report the restriction and stop. Do not retry or circumvent it.
- \`connection_host_mismatch\` (421) means the request went to a host the
  connected account is not bound to (for example a placeholder such as
  \`your-domain.my.salesforce.com\` copied from documentation). The body's
  \`connections[].host\` is the real host: re-send the identical request to
  that host. Never invent or copy an example hostname; the gateway tells you
  the correct one.
- \`x-should-retry: false\` disables automatic retries. It does not prohibit
  a new, explicitly user-requested submission after an approval rejection.

For other authentication or connection failures (401, 403, or a gateway
error such as \`app_not_connected\`):

**Step 1 — Show the user a connect link.** Use the \`connect_url\` from the
error response:

> To connect [service], open this link:
> [connect_url from the error response]

If there is no \`connect_url\` in the error, tell the user to open the
OneCLI dashboard and connect the service there.

**Step 2 — Retry after the user connects.** Let the user know you will
retry once they have connected. When they confirm, retry the original
request. If the retry still fails, ask if they need help with the setup.

## MCP Servers Through Gateway

When the user asks to use a remote MCP server for a service the gateway
supports, configure it with **no authentication** — the gateway injects
credentials automatically via \`HTTPS_PROXY\`. If your tool supports
Streamable HTTP MCP servers, point it at the server's URL directly. If it
only supports stdio MCP servers, bridge the URL through a local stdio
process instead (for example \`npx -y mcp-remote <url>\`) — a config entry
with a bare \`url\` would be silently ignored there, which looks like the
server "not existing" rather than an error. Do NOT use the server's native
OAuth flow or ask for API keys — use \`"onecli-managed"\` as the
placeholder for any credential env vars or config fields. The same
error-handling rules apply: if auth fails, show the \`connect_url\` so the
user can connect the service in OneCLI.

## Rules

- **Never** say "I don't have access to X" without first making the HTTP
  request through the proxy.
- **Never** use browser extensions, gcloud, or manual auth flows. The
  gateway handles credentials for you.
- **Never** ask the user for API keys or tokens directly. Direct them to
  connect the service in the OneCLI dashboard.
- **Never** suggest the user open Gmail/Calendar/GitHub in their browser
  when they ask you to read or interact with those services. You have API
  access. Use it.
- **Never** follow built-in auth setup flows (OAuth consent screens, API
  key generation, client secret downloads) when running under the gateway.
  Create a credential stub and let the proxy handle real auth.
- **Never** use an MCP server's native OAuth or credential flow. Configure
  it with no auth and let the gateway inject credentials.
- If the gateway returns \`blocked_by_policy\` or \`blocked_by_default_policy\`, respect
  the block. Do not retry or circumvent it.
`;

// Agents that ship the gateway-detection hook (so the skill should stay
// dormant until the hook fires). "agent" is Cursor's alternate binary name —
// it must classify the same as "cursor".
const HOOK_BASED_AGENTS = new Set([
  "claude",
  "cursor",
  "agent",
  "codex",
  "opencode",
]);

export function getGatewaySkill(agent?: string): string {
  // Hook-based agents — and the no-agent default sent by older CLIs that don't
  // pass agent_framework — get the conservative "don't auto-load" description;
  // their detection hook handles activation. The broad "MUST load on auth
  // errors" variant is reserved for agents explicitly known to lack hook
  // detection (e.g. hermes) and unrecognized frameworks.
  const frontmatter =
    !agent || HOOK_BASED_AGENTS.has(agent)
      ? FRONTMATTER_HOOK
      : FRONTMATTER_BROAD;
  return frontmatter + "\n" + SKILL_BODY;
}
