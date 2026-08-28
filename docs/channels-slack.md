# Channels: Slack

Every hosted agent can be **its own Slack app** — its own name, its own DM,
answering with the same brain, credentials, and guardrails it has on the web.
A user's DM with an agent **is** their web thread (one conversation, two
doors); a channel thread the agent is mentioned in becomes its own
conversation. Gateway approvals show up as Slack cards with Approve/Deny
buttons.

Slack is the first provider of the platform's **channels** layer; the pieces
below say "channel adapter" because a later provider (WhatsApp, Teams) rides
the same machinery.

## 1. Start the channel adapter

The adapter is the daemon that holds Slack connections and posts answers.
It is opt-in (unlike the runner, which installs enabled by default —
`pnpm run setup --channel-adapter` turns the adapter on at install time):

```bash
# in the .env beside docker-compose.yml (setup/install.sh already provisioned
# CHANNEL_ADAPTER_TOKEN):
COMPOSE_PROFILES=runner,channel-adapter

docker compose up -d
```

No ports, no database, no docker socket. Its traffic goes directly to Slack —
deliberately not through the gateway (platform traffic, not agent traffic).

The adapter uses `APP_URL` for the "Connect a model key" button in its Slack
posts; the compose default points at the install's own address, so set
`APP_URL` in the install `.env` when OneCLI is reached at another address (a
tunnel, a reverse proxy, a real domain).

## 2. (Optional, recommended) Connect the workspace once

An org admin, in **Organization → Settings → Channels**:

1. Open Slack's [app settings](https://api.slack.com/apps) → **Your App
   Configuration Tokens** → generate, and copy the **Refresh Token**
   (`xoxe-…`).
2. Paste it into the Slack card. OneCLI rotates it automatically from then on
   (Slack expires the pair every 12 hours).

This is the accelerator: with it, OneCLI creates each agent's Slack app for
you. Without it, the manifest flow below still works — it is never a gate.

## 3. Add an agent to Slack

On the agent's page → **Channels**:

- **With the org token, on a deployment Slack can reach over public HTTPS**
  (a TLS'd self-host or cloud): click **Add to Slack**, click **Allow** in
  the popup — done. No tokens, no pastes (this is Slack's Events mode; no
  app-level token even exists).
- **With the org token, no public HTTPS** (a laptop, a homelab): OneCLI
  creates the app, then Slack requires two manual steps it has no API for —
  generate the **app-level token** (Basic Information → App-Level Tokens,
  scope `connections:write`) and paste it, then click **Install to
  Workspace** and paste the **Bot User OAuth Token**.
- **Without the org token** (the floor): create the app yourself at
  [api.slack.com/apps](https://api.slack.com/apps?new_app=1) → _From a
  manifest_ → paste the manifest the page shows you, then the same
  generate/install/paste steps (plus the **App ID** and, on the HTTPS arm,
  the **Signing Secret** from Basic Information).

Then open Slack and DM the agent. Only workspace members who map to a OneCLI
user **with access to the agent's workspace** get answers — everyone else gets
a polite refusal before anything reaches the agent. Accounts are matched by
verified email automatically; explicit links live on the org's Channels page.

When a message is accepted you'll see an emoji reaction land on it — the
"seen" mark, picked to fit what you wrote. The full answer arrives as one
message when the agent finishes, and the reaction comes off. (No partial or
self-editing messages — the answer posts once, complete.)

## Troubleshooting

- **"Channels are offline"** — the adapter isn't running or can't reach the
  api service. `docker compose ps channel-adapter`, then its logs.
- **The org card says the token expired** — Slack refused a rotation (the
  pair was revoked, or another tool consumed the single-use refresh token).
  Paste a fresh refresh token; nothing else stops working meanwhile.
- **"Approvals need re-attaching" on an agent** — the member who attached
  Slack lost workspace access, so the agent's approvals key is refused. Detach
  and re-attach (any member with access can).
- **Slack refuses to create the app** — Slack's own limits surface verbatim:
  free workspaces cap installed apps (10), and `managed_app_limit_reached`
  means the config token hit Slack's ceiling for created apps; the manifest
  floor still works.
- **The agent ignores channel chatter** — by design. In channels it answers
  when mentioned, and follows up only inside threads it is already part of.
  Each thread is its own conversation.
- **No reaction appears on accepted messages** — an app installed before the
  `reactions:write` scope was added needs a **reinstall** (open the app's
  settings → Install App → Reinstall to Workspace). Answers still arrive
  either way; only the "seen" mark needs the new scope.
- **Someone without workspace access invited the agent to a channel** — it
  refuses politely and then stays **muted**: it will not respond to anything
  there, and anyone can remove it from the channel. (It deliberately does not
  remove itself — that would require granting every agent bot Slack's
  channel-management scopes.)
