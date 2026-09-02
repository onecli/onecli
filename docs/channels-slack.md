# Channels: Slack

Two Slack apps exist in the platform, with two different jobs:

- **A dedicated app per agent** (how agents live on Slack): the agent is
  **its own Slack app** — its own bot user, its own DM entry in the sidebar.
  With the org's workspace credential connected it is one click.
- **The shared OneCLI app** (how PEOPLE join OneCLI from Slack): one
  deployment-distributed app an admin installs once. Any workspace member
  who messages it gets a button that signs them up (or in) by their
  Slack-verified email — the low-friction onboarding door for the rest of
  the org. Built for the cloud (OneCLI's own distributed app); self-hosts
  can opt in (below), but the usual self-host path is without it.

An agent's dedicated app rides the same brain, credentials, and guardrails
the agent has on the web. A user's DM with an agent **is** their web thread
(one conversation, two doors); a channel thread the agent is mentioned in
becomes its own conversation. Gateway approvals show up as Slack cards with
Approve/Deny buttons. The shared OneCLI app routes to no agent at all — it
answers with the onboarding button and nothing else.

Slack is the first provider of the platform's **channels** layer; the pieces
below say "channel adapter" because a later provider (WhatsApp, Teams) rides
the same machinery.

## The shared app (team onboarding)

**One switch: the credentials.** The four `SLACK_SHARED_*` credentials arm
everything — webhooks, installs begun in Slack, minting agent apps from the
install's user token, and the dashboard's "Add to Slack" advertisement on
the org Channels page (the advertisement also needs the deployment to be
reachable over public HTTPS). Nothing set = the feature simply doesn't
exist, the self-host default.

One more switch guards the minting half: `SLACK_SHARED_APP_MANAGER_APPROVED`
(default off) controls whether installs request the app-manager **user**
scopes (`app_configurations:write`, `managed_apps:install`) that let the
install's user token mint per-agent apps. Flip it only once Slack has
enrolled the app as an app manager — the consent screen grants the scopes
either way, but every `apps.manifest.create` call with the granted token is
refused (`invalid_manager_app`) until enrollment, and manifest creation
declaring the scopes fails outright, so requesting them early only makes
admins grant a permission the deployment cannot use. The
dashboard's setup choice follows this switch too: until it's on, an install
is onboarding-only, so the org Channels page leads with the App
Configuration token paste (the thing that actually enables agent apps) and
offers the shared app as the "or …" alternative; once approved, the shared
app leads and the paste becomes the fallback.

**Cloud:** the shared app is OneCLI's own distributed app, pre-configured.
An org admin opens **Organization → Channels**,
clicks **Add to Slack** on the "Team onboarding" card, and approves the
install (workspaces that gate installs behind admin approval simply complete
later — the link stays valid while it sits in the queue).

**…or the other direction (the Marketplace path):** the install can equally
begin in _Slack_ — the Marketplace listing, the app's sharable URL, or the
Direct Install door at `GET /v1/channels/slack/direct-install` (which 302s
to a state-bearing authorize URL; point the listing's Direct Install URL at
it). Installs begun in Slack carry no org-bound state (no OneCLI session
existed when they started), so the callback lands the browser on
`/slack/installed`: the person signs in (or signs up), the page exchanges
the code and NAMES the workspace it came from, and an explicit confirmation
("connect workspace X to org Y") binds it to the organization of the
session that finishes it — the informed-consent control that keeps a mailed
install link from binding someone else's workspace to your org.
Slack's Marketplace review walks exactly this path, so it is a listing
requirement rather than a convenience — an app that only accepts installs
begun in its own dashboard fails review.

**Self-host (optional, advanced):** most self-hosts skip the shared app —
per-agent apps need none of this. To run your own anyway: create the app
once from `GET /v1/org/channels/slack/shared-manifest` (requires a public
HTTPS `API_URL`; the shared app is events-mode only), then set the four env
vars in the install `.env` and restart the api:

```bash
SLACK_SHARED_CLIENT_ID=...      # Basic Information → App Credentials
SLACK_SHARED_CLIENT_SECRET=...
SLACK_SHARED_SIGNING_SECRET=...
SLACK_SHARED_APP_ID=...         # the A… id
```

**What members see:** DM the OneCLI app (or mention it in a channel) and it
answers with one button — an existing member gets "Open OneCLI"; anyone else
gets "Set up my OneCLI account", backed by an invitation minted for their
Slack-verified email into the installing organization (the standard `/join`
door, so seat caps and the accept-side email check all hold). The bot does
nothing else by design.

## A dedicated app per agent

The original flow — each agent its own Slack app:

### 1. Start the channel adapter

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

### 2. (Optional, recommended) Connect the workspace once

An org admin, in **Organization → Settings → Channels**:

1. Open Slack's [app settings](https://api.slack.com/apps) → **Your App
   Configuration Tokens** → generate, and copy the **Refresh Token**
   (`xoxe-…`).
2. Paste it into the Slack card. OneCLI rotates it automatically from then on
   (Slack expires the pair every 12 hours).

This is the accelerator: with it, OneCLI creates each agent's Slack app for
you. Without it, the socket posture still offers the manual manifest floor;
the HTTPS (events) posture points at this org-level setup instead.

### 3. Add an agent to Slack

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
- **Without the org token**: on the HTTPS (events) posture the agent page
  points at **Organization → Channels** — connect the org token (or the
  shared install) once and come back to one-click. On the socket posture the
  manual floor remains: create the app yourself at
  [api.slack.com/apps](https://api.slack.com/apps?new_app=1) → _From a
  manifest_ → paste the manifest the page shows you, then the same
  generate/install/paste steps (plus the **App ID**).

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
