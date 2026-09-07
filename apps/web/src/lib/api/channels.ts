import { apiDelete, apiGet, apiPost, apiPut } from "./client";

/**
 * Channels (plans/hosted-agents-v2.md step 6): the agent-level presence
 * surface (`/v1/agents/:agentId/channels/*`) and the org-level integration
 * surface (`/v1/org/channels/*`), in one client — the two are halves of the
 * same feature and share every type below.
 *
 * Types are hand-mirrored from `packages/api/src/services/channels/*` (dates
 * arrive as ISO strings over JSON).
 */

export type ChannelProvider = "slack";
export type ChannelTransport = "events" | "socket";
export type ChannelPresenceStatus =
  | "pending_setup"
  | "active"
  | "disabled"
  | "needs_attention";

export interface AgentChannelPresence {
  provider: ChannelProvider;
  status: ChannelPresenceStatus;
  transport: ChannelTransport;
  /** The provider-side app id (Slack: the A… app id — the deep-link target). */
  externalId: string;
  /** The presence's own identity on the provider (Slack: the bot user). */
  identityRef: string | null;
  /** The app's handle in the workspace (Slack: "donna"), where we know it. */
  identityName: string | null;
  tenant: { externalId: string; name: string | null };
  /** The member who attached this presence, for the "Managed by" line. */
  managedBy: { name: string | null; email: string } | null;
  /** Group threads the presence is live in (direct DMs stay private). */
  groupThreads: { externalThreadId: string; createdAt: string }[];
  /** Per-space reach: every channel the presence is in or was asked about.
   * `members_only` = no grant (today's default). Absent on older servers. */
  spaces?: ChannelSpaceReach[];
  /** Absent on older servers that predate the person lane. */
  people?: ChannelPersonReach[];
}

/**
 * How a channel is settled. `pending` means nobody has answered yet, and the
 * agent answers NO ONE there until someone does - it is a real state, not a
 * flavor of "off". The server normalizes the pre-rename `denied`/`revoked`
 * spellings to `members_only`, so they never reach this type.
 */
export type ChannelReachState =
  | "pending"
  | "approved"
  | "members_only"
  | "blocked";

/** One PERSON's reach row: someone who messaged the agent directly with no
 * OneCLI account to match. Two settlements only - "members_only" describes
 * a population, not a person - though a legacy row can still read as one,
 * so the type stays the full union and the UI treats anything that is not
 * `approved`/`pending` as "not allowed". */
export interface ChannelPersonReach {
  externalRef: string;
  /** "@display-name" when known; fall back to the ref. */
  label: string | null;
  state: ChannelReachState;
  decidedAt: string | null;
}

/** One channel's reach row on a presence. */
export interface ChannelSpaceReach {
  externalRef: string;
  /** "#channel-name" when known; fall back to the ref. */
  label: string | null;
  state: ChannelReachState;
  decidedAt: string | null;
}

export interface AgentChannelsView {
  presences: AgentChannelPresence[];
  /** What an attach would use right now — and, on servers that offer a
   * choice, what it could use instead (absent on older servers). */
  posture: { transport: ChannelTransport; available?: ChannelTransport[] };
  /** The org the agent's workspace belongs to — the "set up Slack at the
   * org level" deep-link target. */
  organizationId: string;
  /** Whether the CALLER may open that target (it sits behind the org admin
   * layout, which silently bounces non-admins). Absent on older servers —
   * treat as true (the pre-existing behavior: show the link). */
  viewerIsOrgAdmin?: boolean;
  orgIntegrations: {
    provider: ChannelProvider;
    connected: boolean;
    hasCredentials: boolean;
  }[];
  adapter: { online: boolean; lastSeenAt: string | null };
}

/** The paste floor's step 0 — `material` is provider-defined (Slack: the app
 * manifest JSON), served opaquely and rendered as copyable text. */
export interface ChannelSetupMaterial {
  transport: ChannelTransport;
  material: unknown;
}

export interface CreatePresenceResult {
  presenceId: string;
  transport: ChannelTransport;
  /** Events arm: the one-click consent URL. */
  installUrl: string | null;
  /** Socket arm: where the app-level token is generated + Install lives. */
  settingsUrl: string;
}

export interface CompletePresenceInput {
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  appId?: string;
  /** The floor's chosen mode — sent only when the server offers a choice
   * (`posture.available` present); older strict servers reject unknown keys. */
  transport?: ChannelTransport;
}

/** The completion door's echo of the activated presence row. */
export interface CompletedPresence {
  id: string;
  provider: string;
  externalId: string;
  status: string;
  transport: ChannelTransport;
}

export interface OrgChannelIntegration {
  provider: ChannelProvider;
  /** The provider tenant (Slack: the T… workspace id). */
  externalId: string;
  name: string | null;
  hasCredentials: boolean;
  /** The stored credential died (rotation refused) and needs a re-paste. */
  needsCredentials: boolean;
  credentialsRotatedAt: string | null;
  presenceCount: number;
}

export interface ChannelUserLink {
  id: string;
  externalUserId: string;
  linkedVia: "email" | "manual";
  createdAt: string;
  user: { id: string; email: string; name: string | null };
  integration: { provider: string };
}

export interface OrgChannelsView {
  integrations: OrgChannelIntegration[];
  userLinks: ChannelUserLink[];
  adapter: { online: boolean; lastSeenAt: string | null };
  /** The deployment-wide shared app. `available` is the ADVERTISE signal
   * (configured + public origin); `installation` is returned whenever this
   * org's workspace install exists, so an install made from Slack's side
   * stays visible (and removable) even while `available` is false.
   * Optional: absent on servers that predate the shared app (the deploy
   * checkboxes can skew web ahead of the api-server). */
  sharedApp?: {
    available: boolean;
    /** The install carries a user token that mints agent apps: the config
     * token paste is optional while this is true. */
    canMintAgentApps: boolean;
    /** A NEW install would capture the minting scopes (the deployment's app
     * is Slack-approved as a manager app). Decides which face the setup
     * choice leads with: the OneCLI app when true, the token paste when
     * false (the app is onboarding-only until approval). Absent on older
     * servers — treat as false. */
    installMintsAgentApps?: boolean;
    installation: {
      tenant: { externalId: string; name: string | null };
      botUserId: string | null;
      createdAt: string;
    } | null;
  };
}

// Encoded like `agents.get`: the agent id can arrive DECODED from the URL
// (`useParams`), and an unencoded crafted segment would URL-normalize the
// request onto a different /v1 path under the caller's credentials.
const agentBase = (agentId: string, sub = "") =>
  `/v1/agents/${encodeURIComponent(agentId)}/channels${sub}`;

// ── Agent-level surface ─────────────────────────────────────────────────────

export const agentView = (agentId: string) =>
  apiGet<AgentChannelsView>(agentBase(agentId));

export const manifest = (
  agentId: string,
  provider: ChannelProvider,
  transport?: ChannelTransport,
) =>
  apiGet<ChannelSetupMaterial>(
    agentBase(
      agentId,
      `/${provider}/manifest${transport ? `?transport=${transport}` : ""}`,
    ),
  );

/** The guided arm: create the provider app from the org credential. The
 * transport rides along only when the server offers a choice (older servers
 * read no body and would silently stamp their own default). */
export const attach = (
  agentId: string,
  provider: ChannelProvider,
  input?: { transport?: ChannelTransport },
) =>
  apiPost<CreatePresenceResult>(
    agentBase(agentId, `/${provider}`),
    input ?? {},
  );

/** Settle one channel: open it to everyone in it (same Slack workspace),
 * keep it to OneCLI users only, or block the agent there entirely. */
export const setReachState = (
  agentId: string,
  provider: ChannelProvider,
  externalRef: string,
  state: Exclude<ChannelReachState, "pending">,
) =>
  apiPut<{ kind: string }>(
    agentBase(agentId, `/${provider}/reach/${encodeURIComponent(externalRef)}`),
    { state },
  );

/** Settle one PERSON: may they message this agent, or not. */
export const setPersonReachState = (
  agentId: string,
  provider: ChannelProvider,
  externalRef: string,
  state: "approved" | "blocked",
) =>
  apiPut<{ kind: string }>(
    agentBase(
      agentId,
      `/${provider}/reach/people/${encodeURIComponent(externalRef)}`,
    ),
    { state },
  );

/** DISMISS a person row: forget the decision (grant row only - a person's
 * dismiss never touches thread links, which belong to other people). */
export const dismissPersonReach = (
  agentId: string,
  provider: ChannelProvider,
  externalRef: string,
) =>
  apiDelete(
    agentBase(
      agentId,
      `/${provider}/reach/people/${encodeURIComponent(externalRef)}`,
    ),
  );

/** DISMISS a channel row: forget the channel entirely (grant + thread
 * links). The next outside message re-knocks; a re-mention re-links. */
export const dismissReachRow = (
  agentId: string,
  provider: ChannelProvider,
  externalRef: string,
) =>
  apiDelete(
    agentBase(agentId, `/${provider}/reach/${encodeURIComponent(externalRef)}`),
  );

/** The pasted-tokens completion door (socket arm + the whole paste floor). */
export const complete = (
  agentId: string,
  provider: ChannelProvider,
  input: CompletePresenceInput,
) =>
  apiPost<CompletedPresence>(
    agentBase(agentId, `/${provider}/complete`),
    input,
  );

export const detach = (
  agentId: string,
  provider: ChannelProvider,
  options: { deleteRemote: boolean },
) => apiDelete(agentBase(agentId, `/${provider}`), options);

// ── Org-level surface ───────────────────────────────────────────────────────

export const orgView = () => apiGet<OrgChannelsView>("/v1/org/channels");

/** Connect or refresh the org's automation credential (Slack: the
 * app-configuration refresh token). The server rotates it to validate. */
export const putCredentials = (provider: ChannelProvider, credential: string) =>
  apiPut<{
    provider: ChannelProvider;
    tenant: { externalId: string; name: string | null };
  }>(`/v1/org/channels/${provider}/credentials`, { credential });

export const disconnect = (provider: ChannelProvider) =>
  apiDelete(`/v1/org/channels/${provider}`);

export const addUserLink = (
  provider: ChannelProvider,
  input: { externalUserId: string; userId: string },
) => apiPost<ChannelUserLink>(`/v1/org/channels/${provider}/user-links`, input);

export const removeUserLink = (provider: ChannelProvider, linkId: string) =>
  apiDelete(
    `/v1/org/channels/${provider}/user-links/${encodeURIComponent(linkId)}`,
  );

/** Mint the "Add to Slack" consent URL for the deployment's shared app. */
export const startSharedInstall = (provider: ChannelProvider) =>
  apiPost<{ installUrl: string }>(
    `/v1/org/channels/${provider}/shared-install`,
    {},
  );

/** Spend a code parked by an install that began in Slack's app directory,
 * binding that workspace to the caller's named org. The org travels as an
 * explicit header: the /slack/installed page carries no org in its URL, so
 * the path-derived scope apiFetch computes is empty there — and the server
 * re-fences the header against the caller's active memberships anyway. */
export const inspectSharedInstall = (
  provider: ChannelProvider,
  code: string,
  organizationId: string,
) =>
  apiPost<{ team: { externalId: string; name: string | null }; claim: string }>(
    `/v1/org/channels/${provider}/finish-install/inspect`,
    { code },
    { headers: { "X-Organization-Id": organizationId } },
  );

export const finishSharedInstall = (
  provider: ChannelProvider,
  claim: string,
  organizationId: string,
) =>
  apiPost<{ organizationId: string }>(
    `/v1/org/channels/${provider}/finish-install`,
    { claim },
    { headers: { "X-Organization-Id": organizationId } },
  );

/** Disconnect the org's shared-app install. */
export const disconnectSharedInstall = (provider: ChannelProvider) =>
  apiDelete(`/v1/org/channels/${provider}/shared-install`);
