import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/client";

/**
 * "Connect your Slack" read grants (licensed: granular_access) - the typed
 * client for `/v1/agents/:agentId/slack-read/*`. Types hand-mirror
 * `packages/api/src/ee/slack-read/service.ts` (dates as ISO strings).
 */

/** Per-conversation read/write decision, the Contacts tri-state. */
export type GrantMode = "allow" | "ask" | "never";
export type ConversationKind =
  | "channel"
  | "private_channel"
  | "dm"
  | "group_dm";

export interface SlackProfile {
  handle: string | null;
  realName: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface SlackReadConnection {
  connected: boolean;
  available: boolean;
  profile: SlackProfile | null;
  /** The connection carries the scopes to post as the user. */
  canWrite: boolean;
  /** The viewer's own Slack user id (null when not connected). */
  slackUserId: string | null;
}

export interface MyConversation {
  ref: string;
  kind: ConversationKind;
  name: string;
  /** DM only: the other person's Slack user id. */
  counterpartRef: string | null;
}

export interface ReadGrant {
  id: string;
  subjectKind: ConversationKind;
  externalRef: string;
  subjectLabel: string | null;
  /** DM only: the other person's Slack user id (null for older shares). */
  counterpartRef: string | null;
  readMode: GrantMode;
  writeMode: GrantMode;
  grantedBy: { id: string; name: string | null; email: string };
  /** The viewer made this grant (only they may change it). */
  mine: boolean;
}

const base = (agentId: string) => `/v1/agents/${agentId}/slack-read`;

export const getConnection = (agentId: string) =>
  apiGet<SlackReadConnection>(`${base(agentId)}/connection`);

export const startConnect = (agentId: string) =>
  apiPost<{ authorizeUrl: string }>(`${base(agentId)}/connection`, {});

export const disconnect = (agentId: string) =>
  apiDelete(`${base(agentId)}/connection`);

export const listMyConversations = (agentId: string) =>
  apiGet<{ conversations: MyConversation[] }>(`${base(agentId)}/conversations`);

export const listGrants = (agentId: string) =>
  apiGet<{ grants: ReadGrant[] }>(`${base(agentId)}/grants`);

export interface GrantPatch {
  readMode?: GrantMode;
  writeMode?: GrantMode;
}

export const setGrant = (
  agentId: string,
  externalRef: string,
  patch: GrantPatch,
) =>
  apiPut<ReadGrant>(
    `${base(agentId)}/grants/${encodeURIComponent(externalRef)}`,
    patch,
  );

export const shareMany = (agentId: string, externalRefs: string[]) =>
  apiPost<{ grants: ReadGrant[] }>(`${base(agentId)}/grants`, {
    externalRefs,
  });

export const deleteGrant = (agentId: string, grantId: string) =>
  apiDelete(`${base(agentId)}/grants/${encodeURIComponent(grantId)}`);

export interface SlackReadAgent {
  agentId: string;
  agentName: string;
  imageUrl: string | null;
  handle: string | null;
  connected: boolean;
  sharedByMe: number;
  available: boolean;
}

/** The workspace's agents with a Slack app, and the caller's standing on each. */
export const listSlackReadAgents = () =>
  apiGet<{ agents: SlackReadAgent[] }>(`/v1/slack-read/agents`);
