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
  /** Group threads the presence is live in (direct DMs stay private). */
  groupThreads: { externalThreadId: string; createdAt: string }[];
}

export interface AgentChannelsView {
  presences: AgentChannelPresence[];
  /** What an attach would use right now — and, on servers that offer a
   * choice, what it could use instead (absent on older servers). */
  posture: { transport: ChannelTransport; available?: ChannelTransport[] };
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
