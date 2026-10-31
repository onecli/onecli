import { db, type Prisma } from "@onecli/db";
import {
  authRevoke,
  conversationsHistory,
  conversationsReplies,
  decodeSlackTokens,
  deleteMessage,
  markdownToMrkdwn,
  updateBlocksMessage,
  oauthUserAccess,
  postMessage,
  SlackApiError,
  userConversationInfo,
  usersConversations,
  usersInfo,
  usersList,
  type SlackHistoryMessage,
  type SlackUserConversation,
} from "@onecli/channels/slack";
import { isDeadCredentialError, mentionNamesOf } from "@onecli/channels";
import { resolveMentionNames } from "../../services/channels/mention-resolution-service";
import { getCrypto } from "../../providers";
import { z } from "zod";
import { dashboardUrl } from "../../lib/dashboard-url";
import type {
  ConversationReader,
  ConversationSender,
} from "../../providers/hooks/conversation-reader";
import {
  registerActionHandler,
  requestActionApproval,
  resolveActionApprovals,
  supersedeActionApprovals,
} from "../../services/channels/action-approval-service";
import {
  CONNECT_REASONS,
  SLACK_ACCESS_ACTION,
  slackAccessPayloadSchema,
  type SlackAccessPayload,
  type SlackAccessReason,
} from "../../validations/slack-access";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../../services/audit-service";
import { ServiceError } from "../../services/errors";
import { userDisplayName } from "../../services/user-service";
import { logger } from "../../lib/logger";
import { cleanLabel } from "../../lib/format";
import {
  generateNonce,
  signOAuthState,
  type OAuthStatePayload,
} from "../../lib/oauth-state";
import { parseSlackPresenceCredentials } from "../../services/channels/providers/slack/types";
import {
  READ_MAX_LIMIT,
  READ_MAX_LOOKBACK_HOURS,
} from "../../validations/recipients";
import { assertCanUseGranularAccess } from "../services/quota-service";
import { bumpHomeForAgent } from "../../services/home-sync-service";
import { agentImageUrlOrNull } from "../../services/agent-image-service";

/**
 * "Connect your Slack" read grants (licensed: granular_access).
 *
 * A person connects THEIR Slack through the agent's own app (OAuth with
 * read-only USER scopes) and then picks conversations they are in - channels,
 * private channels, DMs, group DMs - that the agent may read. The token stays
 * on the server; the agent reads through the `read_conversation` platform
 * tool, which this module implements. Three fences, all here:
 *
 *  1. A grant row must exist, and it hangs off the granter's own token row,
 *     so nobody can grant what they cannot see and disconnecting kills every
 *     grant (FK cascade).
 *  2. Only the GRANTER may use it: the turn's verified reader must be the
 *     person who shared it (their own direct thread, or a schedule they
 *     created that reports privately); any shared conversation (a channel thread, a peer
 *     agent, a guest) reads as nobody, even when the granter is the one
 *     asking there.
 *  3. Live: the read uses the granter's token, so Slack itself refuses a
 *     conversation they have since left.
 *
 * Per conversation the granter also picks a READ mode and a WRITE mode
 * (allow | ask | never). `ask` holds the action for the GRANTER's approval
 * (theirs alone to decide: their data, their voice). Sending as the person
 * (`send_as_me`) needs a token that carries `chat:write`; tokens connected
 * before that scope existed read on and simply cannot send.
 */

const log = logger.child({ component: "slack-read" });

export const GRANT_MODES = ["allow", "ask", "never"] as const;
type GrantMode = (typeof GRANT_MODES)[number];

const isGrantMode = (raw: string): raw is GrantMode =>
  (GRANT_MODES as readonly string[]).includes(raw);

/** A stored mode, read defensively (the column is a free string): anything
 * unknown is "never", which only ever narrows. */
const modeOf = (raw: string): GrantMode => (isGrantMode(raw) ? raw : "never");

const SLACK_READ_ACTION = "slack_read_as_user";
const SLACK_SEND_ACTION = "slack_send_as_user";
const SLACK_EDIT_ACTION = "slack_edit_as_user";
const SLACK_DELETE_ACTION = "slack_delete_as_user";
/** How long after sending a message the agent may still change it. */
const OWN_MESSAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const NOT_MY_MESSAGE =
  "I can only change messages I sent as you in the last 24 hours.";
const WRITE_SCOPE = "chat:write";
const NEEDS_RECONNECT_FOR_WRITE =
  "Reconnect your Slack to let the agent send as you.";

type ConversationKind = "channel" | "private_channel" | "dm" | "group_dm";

const STATE_KIND = "slack-user-read";
const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_PAGES = 25;
const DEFAULT_READ_LIMIT = 100;
/** Under the 64k tool-result cap (an oversized result is refused whole by
 * the runner, so truncate here). */
const MAX_MESSAGE_CHARS = 2_000;
const MAX_RESULT_TEXT_CHARS = 48_000;
/** Message subtypes a person (or an integration) authored; every other
 * subtype is channel bookkeeping (joins, topic changes) with nothing to
 * summarize. Hidden subtypes (edits, deletes) never come back from
 * conversations.history at all. */
const AUTHORED_SUBTYPES: ReadonlySet<string> = new Set([
  "bot_message",
  "file_share",
  "me_message",
  "thread_broadcast",
]);

/** Re-render the agent's tools/doc: the read tool is listed only while at
 * least one grant exists, so every change to the grant set re-renders. */
const rerender = (agentId: string): void => {
  void bumpHomeForAgent(agentId).catch((err: unknown) =>
    log.warn({ err, agentId }, "home bump after a read-grant change failed"),
  );
};

// ── The presence and its app credentials ───────────────────────────────────

const slackPresenceSelect = {
  id: true,
  status: true,
  credentials: true,
  externalId: true,
  integration: { select: { externalId: true, organizationId: true } },
  agent: { select: { workspace: { select: { organizationId: true } } } },
} as const satisfies Prisma.AgentChannelSelect;

/** The presence's stored app credentials; an empty set when unreadable (the
 * blob is an input: it survives deploys, so its shape is never assumed). */
const appCredentials = async (encrypted: string | null) => {
  if (!encrypted) return {};
  try {
    return parseSlackPresenceCredentials(await getCrypto().decrypt(encrypted));
  } catch {
    return {};
  }
};

/** Whether the app can run the consent flow at all: active, with OAuth
 * client credentials (paste-floor apps have none). */
const canConnect = (
  status: string,
  creds: { clientId?: string; clientSecret?: string },
): boolean =>
  status === "active" && Boolean(creds.clientId && creds.clientSecret);

/** The agent's Slack presence, fenced to the caller's workspace at the
 * query. Not-found shaped for a foreign or missing agent. */
const requireSlackPresence = async (workspaceId: string, agentId: string) => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId, provider: "slack", agent: { workspaceId } },
    select: slackPresenceSelect,
  });
  if (!presence) throw new ServiceError("NOT_FOUND", "No Slack app attached");
  return presence;
};

/** The presence, licensed for this org: every caller-facing door. */
const requireLicensedPresence = async (
  workspaceId: string,
  agentId: string,
) => {
  const presence = await requireSlackPresence(workspaceId, agentId);
  await assertCanUseGranularAccess(presence.agent.workspace.organizationId);
  return presence;
};

/** The caller's own token row on this presence, or null. */
const findMyToken = (presenceId: string, userId: string) =>
  db.agentChannelUserToken.findUnique({
    where: { agentChannelId_userId: { agentChannelId: presenceId, userId } },
    select: { id: true, externalUserId: true, credentials: true },
  });

/** The stored user credential: the token, plus the scopes Slack reported
 * granting (absent on rows connected before scopes were recorded = no
 * write). */
const decryptUserCredential = async (
  encrypted: string,
): Promise<{ accessToken: string; scopes: string[] } | null> => {
  try {
    const raw: unknown = JSON.parse(await getCrypto().decrypt(encrypted));
    if (raw && typeof raw === "object" && "accessToken" in raw) {
      const { accessToken } = raw;
      if (typeof accessToken !== "string" || !accessToken) return null;
      const scopes =
        "scopes" in raw && Array.isArray(raw.scopes)
          ? raw.scopes.filter((x): x is string => typeof x === "string")
          : [];
      return { accessToken, scopes };
    }
    return null;
  } catch {
    return null;
  }
};

const decryptUserToken = async (encrypted: string): Promise<string | null> =>
  (await decryptUserCredential(encrypted))?.accessToken ?? null;

/** Whether a stored user credential may post as its person. */
const credentialCanWrite = async (encrypted: string): Promise<boolean> =>
  (await decryptUserCredential(encrypted))?.scopes.includes(WRITE_SCOPE) ===
  true;

/** A token that Slack refused as dead: the row goes (and, by cascade, its
 * grants), and the agent re-renders so the tool stops being listed. */
const dropDeadToken = async (
  token: { id: string; agentId: string },
  err: unknown,
): Promise<boolean> => {
  if (!isDeadCredentialError(err)) return false;
  await db.agentChannelUserToken.deleteMany({ where: { id: token.id } });
  rerender(token.agentId);
  return true;
};

/** A Slack person's display name: their chosen display name, else their
 * full name, else their handle. */
const slackPersonName = (u: {
  name?: string;
  profile?: { display_name?: string; real_name?: string };
}): string | undefined =>
  u.profile?.display_name || u.profile?.real_name || u.name;

// ── Connect / disconnect ───────────────────────────────────────────────────

interface SlackProfileView {
  /** The handle ("alex"). */
  handle: string | null;
  /** The full name ("Alex Kim"). */
  realName: string | null;
  email: string | null;
  /** Slack CDN avatar URL (https only). */
  avatarUrl: string | null;
}

interface ConnectionView {
  connected: boolean;
  /** Whether the agent's app can run the consent flow at all. */
  available: boolean;
  /** The CALLER's own Slack profile, when connected. Display only. */
  profile: SlackProfileView | null;
  /** The caller's token carries chat:write: the agent may send as them
   * where they allow it. False = reconnect to enable sending. */
  canWrite: boolean;
  /** The caller's OWN Slack user id (never anyone else's), so the dashboard
   * can tell their own row apart. Null when not connected. */
  slackUserId: string | null;
}

export interface SlackReadAgentView {
  agentId: string;
  agentName: string;
  imageUrl: string | null;
  /** The agent's Slack handle ("helper"), where known. */
  handle: string | null;
  /** The caller has connected THEIR Slack to this agent's app. */
  connected: boolean;
  /** How many conversations the caller has shared with this agent. */
  sharedByMe: number;
  /** The app can run the consent flow (active, with OAuth client creds). */
  available: boolean;
}

/**
 * The workspace-level door: every agent in the workspace with a Slack app,
 * and the CALLER's own standing on each (connected? how many shares?). The
 * connection itself stays per agent - this only finds the agents. Counts
 * are the caller's own; nobody else's tokens or grants are described.
 */
export const listSlackReadAgents = async (input: {
  workspaceId: string;
  organizationId: string;
  userId: string;
}): Promise<SlackReadAgentView[]> => {
  await assertCanUseGranularAccess(input.organizationId);
  const rows = await db.agentChannel.findMany({
    where: {
      provider: "slack",
      status: { in: ["active", "needs_attention"] },
      agent: { workspaceId: input.workspaceId, kind: "hosted" },
    },
    select: {
      status: true,
      credentials: true,
      identityName: true,
      agent: { select: { id: true, name: true, imageKey: true } },
      userTokens: {
        where: { userId: input.userId },
        select: { _count: { select: { grants: true } } },
      },
    },
    orderBy: { agent: { name: "asc" } },
  });
  return Promise.all(
    rows.map(async (row) => {
      const mine = row.userTokens[0];
      return {
        agentId: row.agent.id,
        agentName: row.agent.name,
        imageUrl: agentImageUrlOrNull(row.agent.id, row.agent.imageKey),
        handle: row.identityName,
        connected: mine !== undefined,
        sharedByMe: mine?._count.grants ?? 0,
        available: canConnect(
          row.status,
          await appCredentials(row.credentials),
        ),
      };
    }),
  );
};

/** The CALLER's connection to this agent's app - never anyone else's. */
export const getMyConnection = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
}): Promise<ConnectionView> => {
  const presence = await requireLicensedPresence(
    input.workspaceId,
    input.agentId,
  );
  const creds = await appCredentials(presence.credentials);
  const token = await findMyToken(presence.id, input.userId);
  const profile =
    token && creds.botToken
      ? await usersInfo(creds.botToken, token.externalUserId)
          .then(({ user }): SlackProfileView => {
            const avatar = user.profile?.image_72 ?? user.profile?.image_48;
            return {
              handle:
                cleanLabel(user.profile?.display_name || user.name || "") ??
                null,
              realName: cleanLabel(user.profile?.real_name ?? "") ?? null,
              email: user.profile?.email ?? null,
              // Only an https image URL ever reaches an <img src>.
              avatarUrl: avatar?.startsWith("https://") ? avatar : null,
            };
          })
          .catch(() => null)
      : null;
  return {
    connected: token !== null,
    available: canConnect(presence.status, creds),
    profile,
    canWrite: token ? await credentialCanWrite(token.credentials) : false,
    slackUserId: token?.externalUserId ?? null,
  };
};

/**
 * Begin the consent flow: make sure the app's manifest carries the user read
 * scopes and the redirect (export-then-edit, idempotent), then return the
 * Slack authorize URL with a signed, short-lived, user-bound state.
 * `ensureManifest` is injected so this module never names the presence
 * lifecycle machinery (it already knows how to hold the org's config token).
 */
export const startConnect = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
  redirectUri: string;
  ensureManifest: (presence: {
    externalId: string;
    organizationId: string;
  }) => Promise<readonly string[]>;
}): Promise<{ authorizeUrl: string }> => {
  const presence = await requireLicensedPresence(
    input.workspaceId,
    input.agentId,
  );
  if (presence.status !== "active") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The agent's Slack app isn't connected right now.",
    );
  }
  const creds = await appCredentials(presence.credentials);
  if (!creds.clientId || !creds.clientSecret) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This agent's Slack app was set up by hand, so it can't connect personal accounts. Re-attach it with the guided setup first.",
    );
  }
  const userScopes = await input.ensureManifest({
    externalId: presence.externalId,
    organizationId: presence.integration.organizationId,
  });
  const state = signOAuthState({
    provider: "slack",
    kind: STATE_KIND,
    nonce: generateNonce(),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    presenceId: presence.id,
    userId: input.userId,
    issuedAt: Date.now(),
  });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("user_scope", userScopes.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  // A hint only (Slack may drop it for a person signed in elsewhere): the
  // exchange below checks the team it actually returns, which is the fence.
  url.searchParams.set("team", presence.integration.externalId);
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString() };
};

/** Is this OAuth state one of ours? An UNVERIFIED peek for routing only;
 * `completeConnect` verifies the signature before trusting anything. */
export const isUserReadState = (kind: string | null): boolean =>
  kind === STATE_KIND;

/**
 * Finish the consent flow. Everything that matters is re-derived from the
 * VERIFIED state and the live rows, never from the callback's query:
 *  - the state is HMAC-checked (by the caller), unexpired, and names a
 *    presence that still belongs to the same agent and workspace;
 *  - the token must be for the SAME Slack workspace the agent's app lives
 *    in (a multi-workspace user cannot smuggle another team's token);
 *  - the person must still be an active member of the org, and the Slack
 *    account that approved must be that same person.
 */
export const completeConnect = async (input: {
  state: OAuthStatePayload;
  code: string;
  redirectUri: string;
  exchange: (args: Parameters<typeof oauthUserAccess>[0]) => Promise<{
    team: { id: string };
    authed_user: { id: string; access_token: string; scope?: string };
  }>;
  isActiveMember: (userId: string, organizationId: string) => Promise<boolean>;
}): Promise<{ workspaceId: string; agentId: string }> => {
  const s = input.state;
  if (
    s.kind !== STATE_KIND ||
    typeof s.workspaceId !== "string" ||
    typeof s.agentId !== "string" ||
    typeof s.presenceId !== "string" ||
    typeof s.userId !== "string" ||
    typeof s.issuedAt !== "number" ||
    Date.now() - s.issuedAt > STATE_TTL_MS
  ) {
    throw new ServiceError("UNPROCESSABLE", "This connect link has expired.");
  }
  const { workspaceId, agentId, presenceId, userId } = s;
  const presence = await db.agentChannel.findFirst({
    where: {
      id: presenceId,
      agentId,
      provider: "slack",
      agent: { workspaceId },
    },
    select: slackPresenceSelect,
  });
  if (!presence) {
    throw new ServiceError("UNPROCESSABLE", "This connect link is not valid.");
  }
  const orgId = presence.agent.workspace.organizationId;
  await assertCanUseGranularAccess(orgId);
  const creds = await appCredentials(presence.credentials);
  if (
    !(await input.isActiveMember(userId, orgId)) ||
    !creds.clientId ||
    !creds.clientSecret
  ) {
    throw new ServiceError("UNPROCESSABLE", "This connect link is not valid.");
  }
  const { team, authed_user: person } = await input.exchange({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    code: input.code,
    redirectUri: input.redirectUri,
  });
  if (team.id !== presence.integration.externalId) {
    // Best effort: don't leave a live foreign token behind at Slack.
    await authRevoke(person.access_token).catch(() => undefined);
    throw new ServiceError(
      "UNPROCESSABLE",
      "That was a different Slack workspace. Connect the workspace this agent lives in.",
    );
  }
  // Account-linking CSRF fence: the state names WHO started the flow, but
  // anyone can be sent that authorize link. The Slack person who approved
  // must BE that OneCLI user - their linked Slack identity, or a Slack
  // profile whose email matches theirs. Otherwise one member could start
  // the flow, have a colleague approve it, and own that colleague's token.
  if (!(await isSameIdentity(presence, creds.botToken, userId, person.id))) {
    await authRevoke(person.access_token).catch(() => undefined);
    throw new ServiceError(
      "UNPROCESSABLE",
      "The Slack account that approved doesn't match your OneCLI account. Sign in to Slack as yourself and try again.",
    );
  }
  const scopes = (person.scope ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ accessToken: person.access_token, scopes }),
  );
  const existing = await findMyToken(presence.id, userId);
  // Re-connecting as a DIFFERENT Slack person replaces the old row, and with
  // it every grant made under the old identity (they are that person's
  // conversations, not this one's) - in one transaction, so a failure never
  // leaves the caller disconnected with nothing in its place.
  const changedPerson =
    existing !== null && existing.externalUserId !== person.id;
  await db.$transaction([
    ...(changedPerson
      ? [db.agentChannelUserToken.delete({ where: { id: existing.id } })]
      : []),
    db.agentChannelUserToken.upsert({
      where: {
        agentChannelId_userId: { agentChannelId: presence.id, userId },
      },
      create: {
        agentChannelId: presence.id,
        userId,
        externalUserId: person.id,
        credentials,
      },
      update: { credentials },
    }),
  ]);
  if (changedPerson) rerender(agentId);
  await settleConnectRequests(agentId, userId, scopes.includes(WRITE_SCOPE));
  return { workspaceId, agentId };
};

/**
 * Is Slack user `slackUserId` the same person as OneCLI user `userId`? Yes
 * when a platform link already maps them, or when the Slack profile's email
 * (read with the agent's bot token) equals the OneCLI account's email.
 * A link that maps this Slack id to SOMEONE ELSE is a hard no.
 */
const isSameIdentity = async (
  presence: { integration: { externalId: string; organizationId: string } },
  botToken: string | undefined,
  userId: string,
  slackUserId: string,
): Promise<boolean> => {
  // Fenced to THIS org's integration: another org that installed into the
  // same Slack team keeps its own links.
  const link = await db.channelUserLink.findFirst({
    where: {
      externalUserId: slackUserId,
      integration: {
        provider: "slack",
        externalId: presence.integration.externalId,
        organizationId: presence.integration.organizationId,
      },
    },
    select: { userId: true },
  });
  if (link) return link.userId === userId;
  if (!botToken) return false;
  const [profile, account] = await Promise.all([
    usersInfo(botToken, slackUserId).catch(() => null),
    db.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  const slackEmail = profile?.user.profile?.email?.trim().toLowerCase();
  return Boolean(
    slackEmail &&
    account?.email &&
    slackEmail === account.email.trim().toLowerCase(),
  );
};

/** Disconnect the CALLER's Slack: revoke at Slack (best effort), delete the
 * row, and with it every grant they made (cascade). */
export const disconnect = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
}): Promise<boolean> => {
  const presence = await requireSlackPresence(input.workspaceId, input.agentId);
  const token = await findMyToken(presence.id, input.userId);
  if (!token) return false;
  const accessToken = await decryptUserToken(token.credentials);
  if (accessToken) await authRevoke(accessToken).catch(() => undefined);
  await db.agentChannelUserToken.delete({ where: { id: token.id } });
  rerender(input.agentId);
  return true;
};

// ── The picker and the grants ──────────────────────────────────────────────

interface MyConversation {
  ref: string;
  kind: ConversationKind;
  name: string;
  /** DM only: the other person's Slack user id. */
  counterpartRef: string | null;
}

const kindOf = (c: SlackUserConversation): ConversationKind =>
  c.is_im
    ? "dm"
    : c.is_mpim
      ? "group_dm"
      : c.is_private || c.is_group
        ? "private_channel"
        : "channel";

const KIND_ORDER: Record<ConversationKind, number> = {
  channel: 0,
  private_channel: 1,
  dm: 2,
  group_dm: 3,
};

const displayName = (
  c: SlackUserConversation,
  people: Map<string, string>,
): string => {
  if (c.is_im) return `@${(c.user && people.get(c.user)) ?? "direct message"}`;
  if (c.is_mpim) return cleanLabel(c.name ?? "") ?? "group message";
  return `#${cleanLabel(c.name ?? "") ?? c.id}`;
};

/** A DM's other person (Slack user id); null for anything else. */
const counterpartOf = (c: SlackUserConversation): string | null =>
  c.is_im && c.user ? c.user : null;

/** The caller's licensed presence and their own decrypted token. */
const requireMyToken = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
}) => {
  const presence = await requireLicensedPresence(
    input.workspaceId,
    input.agentId,
  );
  const token = await findMyToken(presence.id, input.userId);
  if (!token) {
    throw new ServiceError("UNPROCESSABLE", "Connect your Slack first.");
  }
  const credential = await decryptUserCredential(token.credentials);
  if (!credential) {
    throw new ServiceError("UNPROCESSABLE", "Reconnect your Slack.");
  }
  return {
    presence,
    token: { id: token.id, agentId: input.agentId },
    accessToken: credential.accessToken,
    canWrite: credential.scopes.includes(WRITE_SCOPE),
  };
};

const CONNECTION_EXPIRED = "Your Slack connection expired. Connect again.";

/**
 * Display names for Slack people, read with the presence's bot token. A FEW
 * people (a page of message authors): one users.info each is cheapest. MANY
 * (a DM list): one paged users.list sweep - per-person users.info is
 * rate-limited (~50/min), so 100 DMs would take minutes.
 */
const peopleNames = async (
  botToken: string | undefined,
  userIds: readonly string[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  const wanted = new Set(userIds);
  if (!botToken || wanted.size === 0) return names;
  const lookUp = (ids: Iterable<string>) =>
    Promise.all(
      [...ids].map(async (id) => {
        const r = await usersInfo(botToken, id).catch(() => null);
        const name = r ? slackPersonName(r.user) : undefined;
        if (name) names.set(id, cleanLabel(name) ?? id);
      }),
    );
  if (wanted.size <= 10) {
    await lookUp(wanted);
    return names;
  }
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && names.size < wanted.size; page += 1) {
    const r = await usersList(botToken, { cursor }).catch(() => null);
    if (!r) break;
    for (const m of r.members) {
      const name = wanted.has(m.id) ? slackPersonName(m) : undefined;
      if (name) names.set(m.id, cleanLabel(name) ?? m.id);
    }
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  // Stragglers the workspace roster doesn't list (Slack Connect people from
  // other orgs, deactivated accounts): a bounded, parallel users.info pass.
  await lookUp([...wanted].filter((id) => !names.has(id)).slice(0, 50));
  return names;
};

/** Every conversation the token's person is in, named for display (a DM
 * shows the other person's name), channels first. */
const listConversationsFor = async (mine: {
  presence: { credentials: string | null };
  token: { id: string; agentId: string };
  accessToken: string;
}): Promise<MyConversation[]> => {
  const raw: SlackUserConversation[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await usersConversations(mine.accessToken, { cursor });
      raw.push(...r.channels.filter((c) => !c.is_archived));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (err) {
    throw new ServiceError(
      "UNPROCESSABLE",
      (await dropDeadToken(mine.token, err))
        ? CONNECTION_EXPIRED
        : "Couldn't load your Slack conversations right now.",
    );
  }
  const { botToken } = await appCredentials(mine.presence.credentials);
  const names = await peopleNames(
    botToken,
    raw.flatMap((c) => (c.is_im && c.user ? [c.user] : [])),
  );
  return raw
    .map((c) => ({
      ref: c.id,
      kind: kindOf(c),
      name: displayName(c, names),
      counterpartRef: counterpartOf(c),
    }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
    );
};

/** The caller's own conversations (what THEY can see): the picker. */
export const listMyConversations = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
}): Promise<MyConversation[]> =>
  listConversationsFor(await requireMyToken(input));

const grantWithGranterSelect = {
  id: true,
  subjectKind: true,
  externalRef: true,
  subjectLabel: true,
  counterpartRef: true,
  readMode: true,
  writeMode: true,
  userToken: {
    select: { user: { select: { id: true, name: true, email: true } } },
  },
} as const satisfies Prisma.AgentReadGrantSelect;

type GrantWithGranter = Prisma.AgentReadGrantGetPayload<{
  select: typeof grantWithGranterSelect;
}>;

/** A grant as the dashboard sees it: who made it, and whether the viewer
 * did (only they may change it). */
const grantView = (
  { userToken, readMode, writeMode, ...grant }: GrantWithGranter,
  viewer: string,
) => ({
  ...grant,
  readMode: modeOf(readMode),
  writeMode: modeOf(writeMode),
  grantedBy: userToken.user,
  mine: userToken.user.id === viewer,
});
type ReadGrantView = ReturnType<typeof grantView>;

/** Write one grant under the caller's token; label and kind come from
 * Slack, never from the client. A NEW share takes only the mode it was made
 * for: shared to read, it reads and never sends; shared to write (a "Send
 * as me" pick, an approved write card), it sends and never reads (consent
 * to post there is not consent to have the history read). An existing
 * share keeps every mode it is not given. */
const saveGrant = (
  tokenId: string,
  conversation: MyConversation,
  settings: {
    readMode?: GrantMode;
    writeMode?: GrantMode;
  },
) => {
  const fields = {
    subjectKind: conversation.kind,
    subjectLabel: conversation.name,
    counterpartRef: conversation.counterpartRef,
    ...(settings.readMode && { readMode: settings.readMode }),
    ...(settings.writeMode && { writeMode: settings.writeMode }),
  };
  const forWriting = settings.writeMode !== undefined && !settings.readMode;
  return db.agentReadGrant.upsert({
    where: {
      userTokenId_externalRef: {
        userTokenId: tokenId,
        externalRef: conversation.ref,
      },
    },
    create: {
      userTokenId: tokenId,
      externalRef: conversation.ref,
      readMode: forWriting ? "never" : "allow",
      writeMode: "never",
      ...fields,
    },
    update: fields,
    select: grantWithGranterSelect,
  });
};

/** Every grant on this agent, whoever made it (the owner's overview), each
 * with its granter. Workspace-fenced at the query. */
export const listGrants = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
}): Promise<ReadGrantView[]> => {
  const presence = await requireLicensedPresence(
    input.workspaceId,
    input.agentId,
  );
  const rows = await db.agentReadGrant.findMany({
    where: { userToken: { agentChannelId: presence.id } },
    select: grantWithGranterSelect,
    orderBy: [{ subjectKind: "asc" }, { subjectLabel: "asc" }],
  });
  return rows.map((row) => grantView(row, input.userId));
};

/** Upper bound on one bulk share (a workspace's worth of picks, not a sweep). */
export const MAX_BULK_SHARE = 200;

/**
 * Share MANY of the caller's own conversations at once (the picker's
 * multi-select). One live listing with THEIR token proves every ref is
 * theirs (all-or-nothing: one foreign ref refuses the whole request), and
 * each becomes its own ordinary grant, individually visible and removable.
 * A static snapshot: conversations joined later are never added implicitly.
 */
export const shareConversations = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
  externalRefs: string[];
}): Promise<ReadGrantView[]> => {
  const refs = [...new Set(input.externalRefs)];
  if (refs.length === 0 || refs.length > MAX_BULK_SHARE) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Pick between 1 and ${MAX_BULK_SHARE} conversations.`,
    );
  }
  const mine = await requireMyToken(input);
  const listed = new Map(
    (await listConversationsFor(mine)).map((c) => [c.ref, c]),
  );
  const picked = refs.flatMap((ref) => listed.get(ref) ?? []);
  if (picked.length !== refs.length) {
    throw new ServiceError(
      "NOT_FOUND",
      "One of those conversations isn't one you're in.",
    );
  }
  const rows = await db.$transaction(
    picked.map((c) => saveGrant(mine.token.id, c, {})),
  );
  rerender(input.agentId);
  return rows.map((row) => grantView(row, input.userId));
};

/**
 * Grant (or re-scope) one conversation, as the CALLER, under THEIR token.
 * Slack is asked about exactly this conversation with their token
 * (conversations.info answers only for conversations they can see, and
 * `is_member` must be true for a channel).
 */
export const upsertGrant = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
  externalRef: string;
  readMode?: GrantMode;
  writeMode?: GrantMode;
}): Promise<ReadGrantView> => {
  if (!input.readMode && !input.writeMode) {
    throw new ServiceError("UNPROCESSABLE", "Nothing to change.");
  }
  const mine = await requireMyToken(input);
  // Sending as the person needs a token that carries chat:write (one
  // connected before the scope existed must reconnect first). Checked
  // before Slack is asked anything.
  if (input.writeMode && input.writeMode !== "never" && !mine.canWrite) {
    throw new ServiceError("UNPROCESSABLE", NEEDS_RECONNECT_FOR_WRITE);
  }
  const notYours = new ServiceError(
    "NOT_FOUND",
    "That conversation isn't one you're in.",
  );
  const info = await userConversationInfo(
    mine.accessToken,
    input.externalRef,
  ).catch(async (err: unknown) => {
    if (await dropDeadToken(mine.token, err)) {
      throw new ServiceError("UNPROCESSABLE", CONNECTION_EXPIRED);
    }
    throw notYours;
  });
  const c = info.channel;
  const isDm = c.is_im === true || c.is_mpim === true;
  if (c.is_archived || (!isDm && c.is_member !== true)) throw notYours;
  const { botToken } = await appCredentials(mine.presence.credentials);
  const names = await peopleNames(botToken, c.is_im && c.user ? [c.user] : []);
  const row = await saveGrant(
    mine.token.id,
    {
      ref: input.externalRef,
      kind: kindOf(c),
      name: displayName(c, names),
      counterpartRef: counterpartOf(c),
    },
    {
      ...(input.readMode && { readMode: input.readMode }),
      ...(input.writeMode && { writeMode: input.writeMode }),
    },
  );
  rerender(input.agentId);
  return grantView(row, input.userId);
};

/**
 * Remove one grant. The granter may remove their own; anyone with access
 * to the agent may also remove any grant on it (revoking only ever narrows
 * what the agent can read, so it needs no extra authority).
 */
export const deleteGrant = async (input: {
  workspaceId: string;
  agentId: string;
  grantId: string;
}): Promise<{ id: string; externalRef: string } | null> => {
  const presence = await requireSlackPresence(input.workspaceId, input.agentId);
  const grant = await db.agentReadGrant.findFirst({
    where: { id: input.grantId, userToken: { agentChannelId: presence.id } },
    select: { id: true, externalRef: true },
  });
  if (!grant) return null;
  await db.agentReadGrant.delete({ where: { id: grant.id } });
  rerender(input.agentId);
  return grant;
};

// ── The read tool ──────────────────────────────────────────────────────────

type ReadConversationInput = Parameters<ConversationReader["read"]>[0];
type ReadConversationOutcome = Awaited<ReturnType<ConversationReader["read"]>>;

const normalize = (s: string) =>
  s.trim().toLowerCase().replace(/^[#@]/, "").replace(/\s+/g, " ");

/** What a failed provider read is called in the log and the tool's answer. */
const readFailureCode = (err: unknown): string => {
  if (err instanceof SlackApiError) return err.code;
  if (!(err instanceof Error)) return "error";
  // slackCall's own non-envelope failures (HTTP status, fetch timeout).
  if (/HTTP 429/.test(err.message)) return "ratelimited";
  if (/timeout|aborted/i.test(err.message)) return "timeout";
  return err.name || "error";
};

const presenceForToolSelect = {
  id: true,
  identityRef: true,
  credentials: true,
  agent: {
    select: { name: true, workspace: { select: { organizationId: true } } },
  },
} as const satisfies Prisma.AgentChannelSelect;

type ToolPresence = Prisma.AgentChannelGetPayload<{
  select: typeof presenceForToolSelect;
}>;

/** The agent's ACTIVE Slack presence, licensed, for the tool doors. */
const toolPresence = async (agentId: string): Promise<ToolPresence | null> => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId, provider: "slack", status: "active" },
    select: presenceForToolSelect,
  });
  if (presence) {
    await assertCanUseGranularAccess(presence.agent.workspace.organizationId);
  }
  return presence;
};

const toolGrantSelect = {
  id: true,
  externalRef: true,
  subjectKind: true,
  subjectLabel: true,
  counterpartRef: true,
  readMode: true,
  writeMode: true,
  userToken: {
    select: {
      id: true,
      userId: true,
      externalUserId: true,
      credentials: true,
      user: { select: { name: true, email: true } },
    },
  },
} as const satisfies Prisma.AgentReadGrantSelect;

type ToolGrant = Prisma.AgentReadGrantGetPayload<{
  select: typeof toolGrantSelect;
}>;

const grantName = (g: { subjectLabel: string | null; externalRef: string }) =>
  g.subjectLabel ?? g.externalRef;

const granterName = (g: ToolGrant): string =>
  cleanLabel(g.userToken.user.name || g.userToken.user.email) || "its owner";

/**
 * What a tool call names. `name` is the model's words; `ref` is the exact
 * provider id when the platform resolved one (send_message's recipient: a
 * channel id, or the person a DM is with); `exact` = no partial names.
 * Reads forgive a near miss ("notif" finds "#notifications"); writes never
 * do, since a near miss would post into someone else's conversation as the
 * person.
 */
interface Asked {
  name: string;
  ref?: string;
  exact: boolean;
}

type Picked<T> =
  | { kind: "one"; item: T }
  | { kind: "none" }
  | { kind: "many"; items: T[] };

const pickedOf = <T>(hits: T[]): Picked<T> =>
  hits.length === 1
    ? { kind: "one", item: hits[0]! }
    : hits.length === 0
      ? { kind: "none" }
      : { kind: "many", items: hits };

/** Resolve `asked` among `items` (already fenced by the caller): the
 * resolved id, else an exact id or name, else (reads only) a unique
 * partial name. Several matches at a step answer "many", never a guess. */
const pick = <T>(
  items: T[],
  view: (item: T) => {
    ref: string;
    name: string | null;
    dmWith: string | null;
  },
  asked: Asked,
): Picked<T> => {
  if (asked.ref) {
    return pickedOf(
      items.filter((i) => {
        const v = view(i);
        return v.ref === asked.ref || v.dmWith === asked.ref;
      }),
    );
  }
  const byRef = items.filter((i) => view(i).ref === asked.name);
  if (byRef.length > 0) return pickedOf(byRef);
  const wanted = normalize(asked.name);
  const named = items.filter((i) => {
    const name = view(i).name;
    return name !== null && normalize(name) === wanted;
  });
  if (named.length > 0 || asked.exact) return pickedOf(named);
  return pickedOf(
    items.filter((i) => {
      const name = view(i).name;
      return name !== null && normalize(name).includes(wanted);
    }),
  );
};

/** One grant for `asked`, or undefined (missing or ambiguous). */
const matchGrant = <
  G extends {
    externalRef: string;
    subjectLabel: string | null;
    subjectKind: string;
    counterpartRef: string | null;
  },
>(
  grants: G[],
  asked: Asked,
): G | undefined => {
  const found = pick(
    grants,
    (g) => ({
      ref: g.externalRef,
      name: g.subjectLabel,
      dmWith: g.subjectKind === "dm" ? g.counterpartRef : null,
    }),
    asked,
  );
  return found.kind === "one" ? found.item : undefined;
};

/** The approval payload of a held read or send: the frozen truth, re-read
 * through this schema (the JSON column is an input). */
const heldReadPayload = z.object({
  grantId: z.string().min(1),
  granterUserId: z.string().min(1),
  granterExternalUserId: z.string().min(1),
  readerUserId: z.string().nullable(),
  sinceHours: z.number().int().positive().optional(),
  threadRef: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
const heldSendPayload = z.object({
  grantId: z.string().min(1),
  granterUserId: z.string().min(1),
  granterExternalUserId: z.string().min(1),
  text: z.string().min(1).max(4000),
});

/** The one person who decides a held read/send: the granter (their Slack
 * is what the agent would use). */
const granterOf = (payload: unknown) => {
  const p = z
    .object({
      granterUserId: z.string().min(1),
      granterExternalUserId: z.string().min(1),
    })
    .safeParse(payload);
  return p.success
    ? {
        userId: p.data.granterUserId,
        externalUserId: p.data.granterExternalUserId,
      }
    : null;
};

/** The granter fence: a grant is usable ONLY in a turn whose verified reader
 * is the person who shared it (null reader = a shared turn = nobody). */
const granterAdmits = (
  g: { userToken: { userId: string } },
  readerUserId: string | null,
) => readerUserId !== null && g.userToken.userId === readerUserId;

// ── Access requests (needs_access) ─────────────────────────────────────────

/** The refusal for a turn with no verified reader (a shared channel or
 * thread, someone else's turn): no card there, since a card in a shared
 * place would let others act or learn of the share. */
const privateChatOnly = async (askerUserId: string | null | undefined) => {
  const person =
    (askerUserId ? await userDisplayName(askerUserId) : null) ?? "someone";
  return `I can only act as ${person} in their own private chat with me (the web chat or a DM with me). Ask there.`;
};

/** The reader's own token row on this presence, and (when it decrypts)
 * their usable credential in the shape the conversation lister takes.
 * Null when not connected. */
const readerToken = async (
  presence: ToolPresence,
  agentId: string,
  readerUserId: string,
) => {
  const row = await findMyToken(presence.id, readerUserId);
  if (!row) return null;
  const credential = await decryptUserCredential(row.credentials);
  return {
    row,
    mine: credential
      ? {
          presence: { credentials: presence.credentials },
          token: { id: row.id, agentId },
          accessToken: credential.accessToken,
          canWrite: credential.scopes.includes(WRITE_SCOPE),
        }
      : null,
  };
};

type Mine = NonNullable<
  NonNullable<Awaited<ReturnType<typeof readerToken>>>["mine"]
>;

/** Resolve what the person asked for among THEIR OWN Slack conversations
 * (live, with their token), by the same rule as their grants. */
const resolveOwnConversation = async (
  mine: Mine,
  asked: Asked,
): Promise<Picked<MyConversation>> =>
  pick(
    await listConversationsFor(mine),
    (c) => ({ ref: c.ref, name: c.name, dmWith: c.counterpartRef }),
    asked,
  );

/** The model-readable answer when `asked` names none, or several, of the
 * person's conversations. */
const unresolved = (
  found: Exclude<Picked<MyConversation>, { kind: "one" }>,
  asked: Asked,
  kind: "read" | "write",
): string => {
  const nothing = kind === "write" ? " Nothing was sent." : "";
  return found.kind === "none"
    ? `They aren't in a Slack conversation matching ${asked.name}.${nothing}`
    : `${asked.name} matches several of their conversations: ${found.items
        .slice(0, 8)
        .map((c) => c.name)
        .join(", ")}. Ask again with the exact name.${nothing}`;
};

const accessSummary = (agentName: string, p: SlackAccessPayload): string => {
  const agent = cleanLabel(agentName) || "the agent";
  const label = p.conversationLabel ?? p.conversationQuery ?? "it";
  switch (p.reason) {
    case "not_connected":
      return p.kind === "read"
        ? `Connect your Slack so ${agent} can read as you`
        : `Connect your Slack so ${agent} can write as you`;
    case "reconnect_for_write":
      return `Reconnect your Slack so ${agent} can write as you`;
    case "not_shared":
      return p.kind === "read"
        ? `Let ${agent} read ${label} as you`
        : `Let ${agent} write in ${label} as you?`;
    case "write_off":
      return `Let ${agent} write in ${label} as you?`;
  }
};

/** What the agent tells the person the card is for, addressed to them (by
 * name: the agent says "you (<Name>)", never someone else). */
const accessNote = (reason: SlackAccessReason, name: string | null): string => {
  const you = name ? `you (${name})` : "you";
  return CONNECT_REASONS.has(reason)
    ? `A card in this chat asks ${you} to connect your Slack. Tell the person you are talking to, in one short line, that the card is for them ("you"), never for the recipient or anyone else; ask again after they connect.`
    : `A card in this chat asks ${you} to allow it; once allowed, the result arrives as a notice in this conversation. Tell the person you are talking to so in one short line, addressing them as "you", never as the recipient.`;
};

/** Open (or reuse) the person's access request and answer needs_access.
 * Deduped per reader+agent+kind+reason+asked conversation (+text for a
 * write): a repeat ask returns the pending one. */
const requestAccess = async (
  presence: ToolPresence,
  agentId: string,
  origin: { conversationId: string | null; turnId: string | null },
  p: Omit<SlackAccessPayload, "agentId">,
) => {
  const payload: SlackAccessPayload = { ...p, agentId };
  const key = (x: SlackAccessPayload) =>
    [
      x.readerUserId,
      x.kind,
      x.reason,
      normalize(x.conversationQuery ?? ""),
      x.text ?? "",
    ].join("|");
  const pending = await db.actionApproval.findMany({
    where: {
      agentId,
      action: SLACK_ACCESS_ACTION,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    select: { id: true, payload: true },
  });
  const same = pending.find((row) => {
    const parsed = slackAccessPayloadSchema.safeParse(row.payload);
    return parsed.success && key(parsed.data) === key(payload);
  });
  // One connect card per person at a time: a fresher connect ask replaces
  // the older pending ones (the newest carries the send to make).
  if (!same && CONNECT_REASONS.has(payload.reason)) {
    const stale = pending.flatMap((row) => {
      const parsed = slackAccessPayloadSchema.safeParse(row.payload);
      return parsed.success &&
        parsed.data.readerUserId === payload.readerUserId &&
        CONNECT_REASONS.has(parsed.data.reason)
        ? [row.id]
        : [];
    });
    await supersedeActionApprovals(stale);
  }
  // The payload is frozen once asked (approvals are immutable), so a write
  // with different text is its own request.
  const id =
    same?.id ??
    (
      await requestActionApproval({
        agentId,
        conversationId: origin.conversationId,
        originTurnId: origin.turnId,
        action: SLACK_ACCESS_ACTION,
        payload,
        summary: accessSummary(presence.agent.name, payload),
      })
    ).id;
  const label = payload.conversationLabel ?? payload.conversationQuery;
  return {
    ok: true as const,
    result: {
      status: "needs_access",
      reason: payload.reason,
      ...(label && { conversation: label }),
      accessRequestId: id,
      note: accessNote(
        payload.reason,
        await userDisplayName(payload.readerUserId),
      ),
    },
  };
};

/** The person asked for a conversation they haven't shared: find it in
 * their own Slack first, so the card names the real conversation (and a
 * name that matches nothing, or many, is answered now, not after a click). */
const notSharedRequest = async (
  presence: ToolPresence,
  origin: { conversationId: string | null; turnId: string | null },
  reader: { userId: string; externalUserId: string; mine: Mine },
  kind: "read" | "write",
  asked: Asked,
  text?: string,
) => {
  let found: Picked<MyConversation>;
  try {
    found = await resolveOwnConversation(reader.mine, asked);
  } catch (err) {
    return {
      ok: false as const,
      error:
        err instanceof ServiceError
          ? err.message
          : "Couldn't look up their Slack conversations right now.",
    };
  }
  if (found.kind !== "one") {
    return { ok: false as const, error: unresolved(found, asked, kind) };
  }
  return requestAccess(presence, reader.mine.token.agentId, origin, {
    readerUserId: reader.userId,
    readerExternalUserId: reader.externalUserId,
    kind,
    reason: "not_shared",
    conversationQuery: asked.name,
    conversationRef: asked.ref ?? found.item.ref,
    conversationLabel: found.item.name,
    ...(text && { text }),
  });
};

/** The person completed Connect: their pending connect requests on this
 * agent are done (a write-reconnect only when the new token can write). */
const settleConnectRequests = async (
  agentId: string,
  userId: string,
  canWrite: boolean,
) => {
  const pending = await db.actionApproval.findMany({
    where: { agentId, action: SLACK_ACCESS_ACTION, status: "pending" },
    select: { id: true, payload: true },
  });
  const settled = pending.flatMap((row) => {
    const p = slackAccessPayloadSchema.safeParse(row.payload);
    if (!p.success || p.data.readerUserId !== userId) return [];
    if (p.data.reason === "not_connected") return [{ id: row.id, p: p.data }];
    if (p.data.reason === "reconnect_for_write" && canWrite) {
      return [{ id: row.id, p: p.data }];
    }
    return [];
  });
  // A write that was waiting on this connect (e.g. "send as me" picked on a
  // choose-sender card) goes out now with its frozen text, or raises its
  // next card (share / allow writing); its request settles saying which.
  const ids: string[] = [];
  for (const { id, p } of settled) {
    if (p.kind !== "write" || !p.text || !p.conversationQuery || !canWrite) {
      ids.push(id);
      continue;
    }
    const origin = await db.actionApproval.findUnique({
      where: { id },
      select: { conversationId: true, originTurnId: true },
    });
    try {
      const out = await sendAsUser({
        agentId,
        readerUserId: userId,
        askerUserId: userId,
        conversation: p.conversationQuery,
        ...(p.conversationRef && { conversationRef: p.conversationRef }),
        text: p.text,
        originConversationId: origin?.conversationId ?? null,
        originTurnId: origin?.originTurnId ?? null,
        ...(p.consented && { consented: true }),
      });
      const status = out.ok ? out.result.status : null;
      const where = p.conversationLabel ?? p.conversationQuery;
      const note = !out.ok
        ? `Slack connected, but the message was not sent: ${out.error}`
        : status === "sent"
          ? `Sent as you to ${where}: "${cleanLabel(p.text, 200)}"`
          : status === "held"
            ? "Slack connected; the message waits for your approval."
            : "Slack connected; one more step is needed before it is sent.";
      await resolveActionApprovals(
        [id],
        note,
        !out.ok
          ? {
              resume: `Not sent to ${where}: ${out.error} Tell the person in one short line; never say it was sent.`,
            }
          : status === "sent"
            ? {
                resume: `Sent as you to ${where}: "${cleanLabel(p.text, 200)}". Already delivered: don't send it again. Confirm in one short line and continue the original request.`,
              }
            : { chained: true },
      );
    } catch (err) {
      log.warn({ err, agentId }, "sending a connect-held write failed");
      ids.push(id);
    }
  }
  try {
    await resolveActionApprovals(ids, "Slack connected; ask again");
  } catch (err) {
    log.warn({ err, agentId }, "settling connect requests failed");
  }
};

/**
 * The `read_conversation` tool's body. Matches the model's name against the
 * agent's grants ONLY (never the workspace), applies the granter fence and
 * the read mode (never = invisible, ask = held for the granter), and reads
 * with the GRANTER's token. A conversation the reader may not see gets the
 * same answer as one that does not exist.
 */
export const readConversation = async (
  input: ReadConversationInput,
): Promise<ReadConversationOutcome> => {
  const presence = await toolPresence(input.agentId);
  if (!presence) {
    return { ok: false, error: "You have no active Slack app to read with." };
  }

  const origin = {
    conversationId: input.originConversationId ?? null,
    turnId: input.originTurnId ?? null,
  };
  const grants = await db.agentReadGrant.findMany({
    where: { userToken: { agentChannelId: presence.id } },
    select: toolGrantSelect,
  });
  const visible = grants.filter(
    (g) =>
      modeOf(g.readMode) !== "never" && granterAdmits(g, input.readerUserId),
  );
  const asked: Asked = {
    name: (input.conversation ?? "").trim(),
    exact: false,
  };
  const named = normalize(asked.name) !== "";
  // The verified person asking, in their own private chat: a missing
  // connection or share is a card for them, never a dead end.
  if (input.readerUserId !== null) {
    const reader = await readerToken(
      presence,
      input.agentId,
      input.readerUserId,
    );
    if (!reader?.mine) {
      return requestAccess(presence, input.agentId, origin, {
        readerUserId: input.readerUserId,
        readerExternalUserId: reader?.row.externalUserId ?? null,
        kind: "read",
        reason: "not_connected",
        conversationQuery: named ? asked.name : null,
        conversationRef: null,
        conversationLabel: null,
      });
    }
    const own = grants.filter((g) => granterAdmits(g, input.readerUserId));
    if (named && !matchGrant(own, asked)) {
      return notSharedRequest(
        presence,
        origin,
        {
          userId: input.readerUserId,
          externalUserId: reader.row.externalUserId,
          mine: reader.mine,
        },
        "read",
        asked,
      );
    }
  } else if (named) {
    return { ok: false, error: await privateChatOnly(input.askerUserId) };
  }
  // No conversation named: list what THIS reader may read (the fences
  // already applied, so nobody learns of a share they can't use).
  if (!named) {
    return {
      ok: true,
      result: {
        readable: visible.map(grantName),
        note:
          visible.length > 0
            ? "Call read_conversation again with one of these names."
            : input.readerUserId === null
              ? "Nothing is readable here: reading as someone works only in their own private chat with you (the web chat or a DM with you)."
              : "Nothing has been shared for you to read here. Call read_conversation with a conversation name to ask them for access.",
      },
    };
  }
  const grant = matchGrant(visible, asked);
  if (!grant) {
    const names = visible.map(grantName);
    return {
      ok: false,
      error: `You don't have read access to ${asked.name} in this conversation.${
        names.length > 0
          ? ` Conversations you may read here: ${names.join(", ")}.`
          : " You have no readable conversations here."
      } Access is granted per conversation by people who connected their Slack in the agent's Contacts ("acts as you").`,
    };
  }
  const params: ReadParams = {
    ...(input.sinceHours !== undefined && { sinceHours: input.sinceHours }),
    ...(input.threadRef && { threadRef: input.threadRef }),
    ...(input.before && { before: input.before }),
    ...(input.limit !== undefined && { limit: input.limit }),
  };
  if (modeOf(grant.readMode) === "ask") {
    const label = grantName(grant);
    await requestActionApproval({
      agentId: input.agentId,
      conversationId: input.originConversationId ?? null,
      originTurnId: input.originTurnId ?? null,
      action: SLACK_READ_ACTION,
      payload: {
        grantId: grant.id,
        granterUserId: grant.userToken.userId,
        granterExternalUserId: grant.userToken.externalUserId,
        readerUserId: input.readerUserId,
        ...params,
      },
      summary: `Read ${label} as ${granterName(grant)}`,
    });
    return {
      ok: true,
      result: {
        status: "held",
        conversation: label,
        note: `Reading ${label} needs your approval each time, you (${granterName(grant)}): a card in this chat asks you. The messages arrive as a notice in this conversation once you approve. Address the person as "you", never "them". If you mention it, one short line; don't explain the approval process.`,
      },
    };
  }
  return performRead(presence, grant, input.agentId, params);
};

interface ReadParams {
  sinceHours?: number;
  threadRef?: string;
  before?: string;
  limit?: number;
}

/** The read itself, with the granter's token (after every fence). */
const performRead = async (
  presence: ToolPresence,
  grant: ToolGrant,
  agentId: string,
  params: ReadParams,
): Promise<ReadConversationOutcome> => {
  const input = { agentId, ...params };
  const label = grantName(grant);

  const accessToken = await decryptUserToken(grant.userToken.credentials);
  if (!accessToken) {
    return {
      ok: false,
      error: `Read access to ${label} needs its owner to reconnect their Slack.`,
    };
  }

  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_READ_LIMIT),
    READ_MAX_LIMIT,
  );
  // No window asked for = the latest messages, however old: an empty answer
  // then really means an empty conversation, never "wrong window".
  const hours =
    input.sinceHours === undefined
      ? null
      : Math.min(Math.max(1, input.sinceHours), READ_MAX_LOOKBACK_HOURS);
  const readHistory = () =>
    conversationsHistory(accessToken, {
      channel: grant.externalRef,
      limit,
      ...(hours !== null && {
        oldest: ((Date.now() - hours * 3_600_000) / 1000).toFixed(6),
      }),
      ...(input.before && { latest: input.before }),
    });
  // A thread id that isn't a thread here is a model slip, not a reason to
  // fail: read the conversation itself and say so.
  let threadFallback = false;
  let page: Awaited<ReturnType<typeof conversationsHistory>>;
  try {
    if (input.threadRef) {
      try {
        page = await conversationsReplies(accessToken, {
          channel: grant.externalRef,
          ts: input.threadRef,
          limit,
        });
      } catch (err) {
        if (!(err instanceof SlackApiError && err.code === "thread_not_found"))
          throw err;
        threadFallback = true;
        page = await readHistory();
      }
    } else {
      page = await readHistory();
    }
  } catch (err) {
    if (
      await dropDeadToken(
        { id: grant.userToken.id, agentId: input.agentId },
        err,
      )
    ) {
      return {
        ok: false,
        error: `Read access to ${label} ended: its owner's Slack connection is gone.`,
      };
    }
    const code = readFailureCode(err);
    log.warn(
      {
        err,
        agentId: input.agentId,
        conversationRef: grant.externalRef,
        code,
        thread: Boolean(input.threadRef),
        hours,
        limit,
      },
      "read_conversation provider read failed",
    );
    return {
      ok: false,
      error:
        code === "ratelimited"
          ? `Slack is rate-limiting reads of ${label}. Wait a minute, then read it once with a wider sinceHours instead of several small reads.`
          : `Couldn't read ${label} right now (Slack: ${code}). Try again later.`,
    };
  }

  const isThread = Boolean(input.threadRef) && !threadFallback;
  const messages = page.messages.filter(
    (m) => !m.subtype || AUTHORED_SUBTYPES.has(m.subtype),
  );
  // History comes newest first, a thread oldest first: read oldest first.
  if (!isThread) messages.reverse();

  const { out, truncated } = await renderMessages(presence, messages);
  // More messages exist past what came back: for history, hand the model the
  // exact cursor to keep going (the oldest message it received), so "the
  // first message" is never confused with "the first message in this page".
  const more = page.has_more === true || truncated;
  const moreOlder = !isThread && more;
  const nextBefore = moreOlder ? out[0]?.id : undefined;
  const notes: string[] = [];
  if (threadFallback) {
    notes.push(
      `${input.threadRef} is not a thread here, so this is the conversation itself.`,
    );
  }
  notes.push(
    isThread
      ? out.length === 0
        ? "This thread has no replies to show."
        : more
          ? `Partial: these are the thread's first ${out.length} messages and the thread has more. Say so rather than treating them as the whole thread.`
          : "These are the thread's messages."
      : moreOlder
        ? `Partial: ${out.length} messages from ${out[0]?.at ?? "?"} to ${out[out.length - 1]?.at ?? "?"}, and OLDER messages exist. This is NOT the start of the conversation. To read further back, call again with before="${nextBefore}"; repeat until reachedStart is true before stating totals, counts, or the first message.`
        : out.length === 0
          ? hours === null
            ? "The read worked: there are no messages here."
            : `The read worked: no messages in the last ${hours} hours. Leave sinceHours out to get the latest messages.`
          : hours === null
            ? "Complete: this is everything back to the start of the conversation."
            : `Complete for the last ${hours} hours.`,
  );

  return {
    ok: true,
    result: {
      conversation: label,
      messages: out,
      ...(!isThread && {
        reachedStart: !moreOlder && hours === null,
        ...(nextBefore && { nextBefore }),
      }),
      note: notes.join(" "),
      ...(hours !== null && !isThread && { window: { sinceHours: hours } }),
    },
  };
};

// ── Send as the person ─────────────────────────────────────────────────────

type SendInput = Parameters<ConversationSender["send"]>[0];
type SendOutcome = Awaited<ReturnType<ConversationSender["send"]>>;

/** Audit one send as the granter (never the text: it is their message). */
const auditSend = async (
  grant: ToolGrant,
  agentId: string,
  outcome: "sent" | "held",
  approvalId?: string,
) => {
  const workspace = await db.agent.findUnique({
    where: { id: agentId },
    select: { workspaceId: true },
  });
  if (!workspace) return;
  await recordAuditEvent({
    workspaceId: workspace.workspaceId,
    userId: grant.userToken.userId,
    userEmail: grant.userToken.user.email,
    action: AUDIT_ACTIONS.CREATE,
    service: AUDIT_SERVICES.CHANNEL,
    source: AUDIT_SOURCE.API,
    metadata: {
      agentId,
      viaAgent: "true",
      sendAsUser: outcome,
      readGrantId: grant.id,
      conversationRef: grant.externalRef,
      writeMode: modeOf(grant.writeMode),
      ...(approvalId && { actionApprovalId: approvalId }),
    },
  });
};

/**
 * The person's message as Slack text: the markdown renderer the agent's own
 * posts use (everything escaped, so no raw `<@…>` / `<!channel>` from the
 * model), with `@[Name]` tokens resolved the way send_message resolves them
 * (anchors, then linked teammates) into real mentions. The agent's contact
 * blocks do NOT apply: this is the person's own message under their own
 * Slack. Unresolved tokens read as `@Name`.
 */
const renderAsPersonText = async (
  agentId: string,
  text: string,
  conversationId: string | null,
): Promise<string> => {
  const names = mentionNamesOf(text);
  const presence =
    names.length > 0
      ? await db.agentChannel.findFirst({
          where: { agentId, provider: "slack", status: "active" },
          select: { id: true },
        })
      : null;
  const mentions = new Map<string, string>();
  if (presence) {
    for (const r of await resolveMentionNames(
      presence.id,
      names,
      conversationId ?? undefined,
    )) {
      if (r.kind === "resolved") mentions.set(r.name, r.externalUserId);
    }
  }
  return markdownToMrkdwn(text, { mentions });
};

/** Post with the granter's token. Throws a model-readable Error. */
const postAsGranter = async (
  grant: ToolGrant,
  agentId: string,
  text: string,
  conversationId: string | null = null,
) => {
  const label = grantName(grant);
  const credential = await decryptUserCredential(grant.userToken.credentials);
  if (!credential?.scopes.includes(WRITE_SCOPE)) {
    throw new Error(
      `${granterName(grant)} must reconnect their Slack before the agent can send as them.`,
    );
  }
  let ts: string;
  try {
    ({ ts } = await postMessage(credential.accessToken, {
      channel: grant.externalRef,
      text: await renderAsPersonText(agentId, text, conversationId),
    }));
  } catch (err) {
    if (await dropDeadToken({ id: grant.userToken.id, agentId }, err)) {
      throw new Error(
        `Sending to ${label} ended: ${granterName(grant)}'s Slack connection is gone.`,
      );
    }
    const code = readFailureCode(err);
    log.warn(
      { err, agentId, conversationRef: grant.externalRef, code },
      "send_as_me provider post failed",
    );
    throw new Error(`Couldn't send to ${label} (Slack: ${code}).`);
  }
  // The record is what edit/delete may later touch. A failed write here
  // must not report a sent message as unsent: log and carry on.
  try {
    await db.agentSentAsUser.create({
      data: {
        grantId: grant.id,
        userTokenId: grant.userToken.id,
        agentId,
        channelRef: grant.externalRef,
        messageTs: ts,
      },
    });
  } catch (err) {
    log.warn({ err, agentId }, "recording a send_as_me message failed");
  }
  return ts;
};

/** "Send as me" picked: resolve the conversation with THEIR token (it
 * must be one they are in) and save it with writing allowed. */
const consentToWrite = async (
  mine: Mine,
  userId: string,
  asked: Asked,
): Promise<{ ok: true; grant: ToolGrant } | { ok: false; error: string }> => {
  const agentId = mine.token.agentId;
  let found: Picked<MyConversation>;
  try {
    found = await resolveOwnConversation(mine, asked);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof ServiceError
          ? `${err.message} Nothing was sent.`
          : "Couldn't look up their Slack conversations right now. Nothing was sent.",
    };
  }
  if (found.kind !== "one") {
    return { ok: false, error: unresolved(found, asked, "write") };
  }
  const saved = await saveGrant(mine.token.id, found.item, {
    writeMode: "allow",
  });
  rerender(agentId);
  const [workspace, user] = await Promise.all([
    db.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true },
    }),
    db.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  if (workspace) {
    await recordAuditEvent({
      workspaceId: workspace.workspaceId,
      userId,
      userEmail: user?.email ?? "",
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId,
        readGrantId: saved.id,
        conversationRef: found.item.ref,
        writeMode: "allow",
        via: "choose_sender",
      },
    });
  }
  return {
    ok: true,
    grant: await db.agentReadGrant.findUniqueOrThrow({
      where: { id: saved.id },
      select: toolGrantSelect,
    }),
  };
};

/**
 * Whether sending as a person is possible for this agent: a live Slack
 * presence on a licensed org. The person's own connection is not checked
 * (a choice to send as them chains the Connect card). Never throws.
 */
export const canSendAsUser = async (agentId: string): Promise<boolean> => {
  try {
    return (await toolPresence(agentId)) !== null;
  } catch {
    return false;
  }
};

/**
 * The `send_as_me` tool's body. Only the READER's OWN grants are
 * targetable (a null reader, any shared conversation, refuses): the person
 * is the one asking, in their own private thread or schedule, to speak as
 * themselves. `allow` posts now; `ask` holds for their approval; `never`
 * (or a token without chat:write) refuses.
 */
export const sendAsUser = async (input: SendInput): Promise<SendOutcome> => {
  if (input.readerUserId === null) {
    return {
      ok: false,
      error: `${await privateChatOnly(input.askerUserId)} Nothing was sent.`,
    };
  }
  const presence = await toolPresence(input.agentId);
  if (!presence) {
    return { ok: false, error: "You have no active Slack app to send with." };
  }
  const origin = {
    conversationId: input.originConversationId,
    turnId: input.originTurnId,
  };
  // A write never guesses: an exact name, or the platform's resolved id.
  const asked: Asked = {
    name: input.conversation.trim(),
    ...(input.conversationRef && { ref: input.conversationRef }),
    exact: true,
  };
  const reader = await readerToken(presence, input.agentId, input.readerUserId);
  const readerUserId = input.readerUserId;
  const access = (
    reason: SlackAccessReason,
    conv: { ref: string; label: string } | null,
  ) =>
    requestAccess(presence, input.agentId, origin, {
      readerUserId,
      readerExternalUserId: reader?.row.externalUserId ?? null,
      kind: "write",
      reason,
      conversationQuery: asked.name,
      // The platform's resolved recipient wins: it is what a later card
      // for the same send (or its undo) is matched on.
      conversationRef: asked.ref ?? conv?.ref ?? null,
      conversationLabel: conv?.label ?? null,
      text: input.text,
      ...(input.consented && { consented: true }),
    });
  if (!reader?.mine) return access("not_connected", null);
  const mine = await db.agentReadGrant.findMany({
    where: {
      userToken: { agentChannelId: presence.id, userId: readerUserId },
    },
    select: toolGrantSelect,
  });
  let grant = matchGrant(mine, asked);
  if (!reader.mine.canWrite) {
    return access(
      "reconnect_for_write",
      grant ? { ref: grant.externalRef, label: grantName(grant) } : null,
    );
  }
  if (input.consented && (!grant || modeOf(grant.writeMode) !== "allow")) {
    // The pick is the consent: share (or upgrade) this one conversation
    // with writing allowed, persisted, so later sends need no card.
    const consented = await consentToWrite(
      reader.mine,
      readerUserId,
      grant ? { name: grant.externalRef, exact: true } : asked,
    );
    if (!consented.ok) return consented;
    grant = consented.grant;
  }
  if (!grant) {
    return notSharedRequest(
      presence,
      origin,
      {
        userId: readerUserId,
        externalUserId: reader.row.externalUserId,
        mine: reader.mine,
      },
      "write",
      asked,
      input.text,
    );
  }
  if (modeOf(grant.writeMode) === "never") {
    return access("write_off", {
      ref: grant.externalRef,
      label: grantName(grant),
    });
  }
  const label = grantName(grant);
  if (modeOf(grant.writeMode) === "ask") {
    const held = await requestActionApproval({
      agentId: input.agentId,
      conversationId: input.originConversationId,
      originTurnId: input.originTurnId,
      action: SLACK_SEND_ACTION,
      payload: {
        grantId: grant.id,
        granterUserId: grant.userToken.userId,
        granterExternalUserId: grant.userToken.externalUserId,
        text: input.text,
      },
      summary: `Send to ${label} as ${granterName(grant)}: "${cleanLabel(input.text, 300)}"`,
    });
    await auditSend(grant, input.agentId, "held", held.id);
    return {
      ok: true,
      result: {
        status: "held",
        conversation: label,
        note: `A card in this chat asks you (${granterName(grant)}) to approve it; the decision arrives as a notice in this conversation. Address the person as "you", never "them" or the recipient. If you mention it, one short line; don't explain the approval process.`,
      },
    };
  }
  let messageId: string;
  try {
    messageId = await postAsGranter(
      grant,
      input.agentId,
      input.text,
      input.originConversationId,
    );
  } catch (err) {
    return {
      ok: false,
      error: `${err instanceof Error ? err.message : String(err)} Nothing was sent.`,
    };
  }
  await auditSend(grant, input.agentId, "sent");
  return {
    ok: true,
    result: {
      status: "sent",
      conversation: label,
      messageId,
      note: `Sent to ${label} as ${granterName(grant)}.`,
    },
  };
};

// ── Edit / delete a message sent as the person ─────────────────────────────

type OwnMessageInput = Parameters<ConversationSender["delete"]>[0];

/** Audit one edit/delete as the granter (never the text). */
const auditOwnMessage = async (
  grant: ToolGrant,
  agentId: string,
  op: "edit" | "delete",
  outcome: "done" | "held",
  messageTs: string,
  approvalId?: string,
) => {
  const workspace = await db.agent.findUnique({
    where: { id: agentId },
    select: { workspaceId: true },
  });
  if (!workspace) return;
  await recordAuditEvent({
    workspaceId: workspace.workspaceId,
    userId: grant.userToken.userId,
    userEmail: grant.userToken.user.email,
    action: op === "edit" ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.DELETE,
    service: AUDIT_SERVICES.CHANNEL,
    source: AUDIT_SOURCE.API,
    metadata: {
      agentId,
      viaAgent: "true",
      [op === "edit" ? "editAsUser" : "deleteAsUser"]: outcome,
      readGrantId: grant.id,
      conversationRef: grant.externalRef,
      messageTs,
      writeMode: modeOf(grant.writeMode),
      ...(approvalId && { actionApprovalId: approvalId }),
    },
  });
};

/** The record of a message THIS agent sent as THIS person in THIS
 * conversation, still inside the window. Null = not ours to touch. */
const findOwnMessage = (
  agentId: string,
  grant: ToolGrant,
  messageTs: string,
  now: Date = new Date(),
) =>
  db.agentSentAsUser.findFirst({
    where: {
      agentId,
      grantId: grant.id,
      userTokenId: grant.userToken.id,
      channelRef: grant.externalRef,
      messageTs,
      createdAt: { gte: new Date(now.getTime() - OWN_MESSAGE_WINDOW_MS) },
    },
    select: { id: true },
  });

/**
 * The shared fence for edit/delete: a verified reader, their OWN grant for
 * the named conversation, and a recorded send_as_me message by this agent
 * with their token there in the last 24h. Anything else gets the same
 * refusal (the message is not confirmed to exist).
 */
const resolveOwnMessage = async (
  input: OwnMessageInput,
  op: "edit" | "delete",
): Promise<
  | { kind: "done"; outcome: SendOutcome }
  | { kind: "ok"; grant: ToolGrant; credential: { accessToken: string } }
> => {
  const nothing =
    op === "edit" ? "Nothing was changed." : "Nothing was deleted.";
  if (input.readerUserId === null) {
    return {
      kind: "done",
      outcome: {
        ok: false,
        error: `${await privateChatOnly(input.askerUserId)} ${nothing}`,
      },
    };
  }
  const presence = await toolPresence(input.agentId);
  if (!presence) {
    return {
      kind: "done",
      outcome: { ok: false, error: "You have no active Slack app to use." },
    };
  }
  const refuse = {
    kind: "done" as const,
    outcome: { ok: false as const, error: NOT_MY_MESSAGE },
  };
  const readerUserId = input.readerUserId;
  const reader = await readerToken(presence, input.agentId, readerUserId);
  if (!reader?.mine) return refuse;
  const mine = await db.agentReadGrant.findMany({
    where: {
      userToken: { agentChannelId: presence.id, userId: readerUserId },
    },
    select: toolGrantSelect,
  });
  const asked: Asked = { name: input.conversation.trim(), exact: true };
  const grant = matchGrant(mine, asked);
  if (
    !grant ||
    !(await findOwnMessage(input.agentId, grant, input.messageId))
  ) {
    return refuse;
  }
  const origin = {
    conversationId: input.originConversationId,
    turnId: input.originTurnId,
  };
  const access = (reason: SlackAccessReason) =>
    requestAccess(presence, input.agentId, origin, {
      readerUserId,
      readerExternalUserId: reader.row.externalUserId,
      kind: "write",
      reason,
      conversationQuery: asked.name,
      conversationRef: grant.externalRef,
      conversationLabel: grantName(grant),
      // No text: approving access must never post the edit as a NEW message.
    });
  if (!reader.mine.canWrite) {
    return { kind: "done", outcome: await access("reconnect_for_write") };
  }
  if (modeOf(grant.writeMode) === "never") {
    return { kind: "done", outcome: await access("write_off") };
  }
  return {
    kind: "ok",
    grant,
    credential: { accessToken: reader.mine.accessToken },
  };
};

/** Run a Slack write with the granter's token; model-readable errors. */
const asGranter = async (
  grant: ToolGrant,
  agentId: string,
  what: string,
  run: (accessToken: string) => Promise<unknown>,
) => {
  const credential = await decryptUserCredential(grant.userToken.credentials);
  if (!credential?.scopes.includes(WRITE_SCOPE)) {
    throw new Error(
      `${granterName(grant)} must reconnect their Slack before the agent can ${what} as them.`,
    );
  }
  try {
    await run(credential.accessToken);
  } catch (err) {
    if (await dropDeadToken({ id: grant.userToken.id, agentId }, err)) {
      throw new Error(`${granterName(grant)}'s Slack connection is gone.`);
    }
    const code = readFailureCode(err);
    log.warn(
      { err, agentId, conversationRef: grant.externalRef, code },
      `${what} as user failed`,
    );
    throw new Error(`Couldn't ${what} the message (Slack: ${code}).`);
  }
};

const performEdit = (
  grant: ToolGrant,
  agentId: string,
  messageTs: string,
  text: string,
  conversationId: string | null,
) =>
  asGranter(grant, agentId, "edit", async (token) =>
    updateBlocksMessage(token, {
      channel: grant.externalRef,
      ts: messageTs,
      text: await renderAsPersonText(agentId, text, conversationId),
    }),
  );

const performDelete = async (
  grant: ToolGrant,
  agentId: string,
  messageTs: string,
) => {
  await asGranter(grant, agentId, "delete", (token) =>
    deleteMessage(token, { channel: grant.externalRef, ts: messageTs }),
  );
  await db.agentSentAsUser.deleteMany({
    where: { channelRef: grant.externalRef, messageTs },
  });
};

/** The message's current text (for the delete card), with the granter's
 * token. Best effort: null when it can't be read. */
const messageTextOf = async (
  accessToken: string,
  channel: string,
  ts: string,
): Promise<string | null> => {
  try {
    const page = await conversationsHistory(accessToken, {
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const m = page.messages.find((x) => x.ts === ts);
    return m?.text
      ? cleanLabel(await decodeSlackTokens(m.text, async () => null), 300)
      : null;
  } catch (err) {
    log.warn({ err, channel }, "reading a message to delete failed");
    return null;
  }
};

const heldOwnPayload = z.object({
  grantId: z.string().min(1),
  granterUserId: z.string().min(1),
  granterExternalUserId: z.string().min(1),
  messageTs: z.string().min(1),
});
const heldEditPayload = heldOwnPayload.extend({
  text: z.string().min(1).max(4000),
});

/**
 * The `edit_my_message` tool's body: allow edits now, ask holds for the
 * person, never answers with an access card.
 */
export const editAsUser = async (
  input: OwnMessageInput & { text: string },
): Promise<SendOutcome> => {
  const found = await resolveOwnMessage(input, "edit");
  if (found.kind === "done") return found.outcome;
  const { grant } = found;
  const label = grantName(grant);
  if (modeOf(grant.writeMode) === "ask") {
    const held = await requestActionApproval({
      agentId: input.agentId,
      conversationId: input.originConversationId,
      originTurnId: input.originTurnId,
      action: SLACK_EDIT_ACTION,
      payload: {
        grantId: grant.id,
        granterUserId: grant.userToken.userId,
        granterExternalUserId: grant.userToken.externalUserId,
        messageTs: input.messageId,
        text: input.text,
      },
      summary: `Edit your message in ${label} to: "${cleanLabel(input.text, 300)}"`,
    });
    await auditOwnMessage(
      grant,
      input.agentId,
      "edit",
      "held",
      input.messageId,
      held.id,
    );
    return {
      ok: true,
      result: {
        status: "held",
        conversation: label,
        messageId: input.messageId,
        note: `A card in this chat asks you (${granterName(grant)}) to approve it; the decision arrives as a notice in this conversation. Address the person as "you", never "them". If you mention it, one short line.`,
      },
    };
  }
  try {
    await performEdit(
      grant,
      input.agentId,
      input.messageId,
      input.text,
      input.originConversationId,
    );
  } catch (err) {
    return {
      ok: false,
      error: `${err instanceof Error ? err.message : String(err)} Nothing was changed.`,
    };
  }
  await auditOwnMessage(grant, input.agentId, "edit", "done", input.messageId);
  return {
    ok: true,
    result: {
      status: "edited",
      conversation: label,
      messageId: input.messageId,
      note: `Edited the message in ${label}.`,
    },
  };
};

/**
 * The `delete_my_message` tool's body: ALWAYS held for the person (even
 * with writing on allow); the card shows what would be deleted.
 */
export const deleteAsUser = async (
  input: OwnMessageInput,
): Promise<SendOutcome> => {
  const found = await resolveOwnMessage(input, "delete");
  if (found.kind === "done") return found.outcome;
  const { grant } = found;
  const label = grantName(grant);
  const current = await messageTextOf(
    found.credential.accessToken,
    grant.externalRef,
    input.messageId,
  );
  const held = await requestActionApproval({
    agentId: input.agentId,
    conversationId: input.originConversationId,
    originTurnId: input.originTurnId,
    action: SLACK_DELETE_ACTION,
    payload: {
      grantId: grant.id,
      granterUserId: grant.userToken.userId,
      granterExternalUserId: grant.userToken.externalUserId,
      messageTs: input.messageId,
    },
    summary: current
      ? `Delete your message in ${label}: "${current}"`
      : `Delete your message in ${label}`,
  });
  await auditOwnMessage(
    grant,
    input.agentId,
    "delete",
    "held",
    input.messageId,
    held.id,
  );
  return {
    ok: true,
    result: {
      status: "held",
      conversation: label,
      messageId: input.messageId,
      note: `Deleting always needs your approval: a card in this chat asks you (${granterName(grant)}). Address the person as "you", never "them". The decision arrives as a notice in this conversation. If you mention it, one short line.`,
    },
  };
};

/** A held edit/delete, re-checked at decide time: the grant still theirs
 * and writable, and the message still a recorded send of this agent. */
const reloadOwnMessage = async (
  agentId: string,
  payload: z.infer<typeof heldOwnPayload>,
) => {
  const { grant } = await reloadHeldGrant(agentId, payload);
  if (modeOf(grant.writeMode) === "never") {
    throw new Error("Writing in this conversation is no longer allowed.");
  }
  if (!(await findOwnMessage(agentId, grant, payload.messageTs))) {
    throw new Error("That message can no longer be changed.");
  }
  return grant;
};

/** A held grant, re-read at decide time: it must still exist on an active
 * presence of THIS agent, still belong to the same granter, and still allow
 * the action (a mode turned to never after the ask kills it). */
const reloadHeldGrant = async (
  agentId: string,
  payload: { grantId: string; granterUserId: string },
) => {
  const presence = await toolPresence(agentId);
  if (!presence) throw new Error("The agent's Slack app isn't active.");
  const grant = await db.agentReadGrant.findFirst({
    where: {
      id: payload.grantId,
      userToken: {
        agentChannelId: presence.id,
        userId: payload.granterUserId,
      },
    },
    select: toolGrantSelect,
  });
  if (!grant) throw new Error("That conversation is no longer shared.");
  return { presence, grant };
};

/** An approved read's result rides the outcome note; bounded so the note
 * stays a context block, not a flood. */
const HELD_READ_NOTE_MAX = 16_000;

registerActionHandler(
  SLACK_READ_ACTION,
  async (approval) => {
    const payload = heldReadPayload.parse(approval.payload);
    const { presence, grant } = await reloadHeldGrant(
      approval.agentId,
      payload,
    );
    if (
      modeOf(grant.readMode) === "never" ||
      !granterAdmits(grant, payload.readerUserId)
    ) {
      throw new Error("Reading this conversation is no longer allowed.");
    }
    const outcome = await performRead(presence, grant, approval.agentId, {
      ...(payload.sinceHours !== undefined && {
        sinceHours: payload.sinceHours,
      }),
      ...(payload.threadRef && { threadRef: payload.threadRef }),
      ...(payload.before && { before: payload.before }),
      ...(payload.limit !== undefined && { limit: payload.limit }),
    });
    if (!outcome.ok) throw new Error(outcome.error);
    return `The read result (JSON): ${JSON.stringify(outcome.result)}`.slice(
      0,
      HELD_READ_NOTE_MAX,
    );
  },
  {
    decidedBy: granterOf,
    noteMaxChars: HELD_READ_NOTE_MAX,
    resumeOnExecute: true,
  },
);

/** A held send/edit/delete is about one message: the same person, the
 * same conversation, and the same message (an edit/delete's ts, or a
 * send's exact text). */
const heldMessageKey = (payload: unknown) => {
  const p = z
    .object({
      granterUserId: z.string(),
      grantId: z.string(),
      messageTs: z.string().optional(),
      text: z.string().optional(),
    })
    .safeParse(payload);
  return p.success
    ? [
        p.data.granterUserId,
        p.data.grantId,
        p.data.messageTs ?? `text:${p.data.text ?? ""}`,
      ].join("|")
    : null;
};

registerActionHandler(
  SLACK_SEND_ACTION,
  async (approval) => {
    const payload = heldSendPayload.parse(approval.payload);
    const { grant } = await reloadHeldGrant(approval.agentId, payload);
    if (modeOf(grant.writeMode) === "never") {
      throw new Error("Sending to this conversation is no longer allowed.");
    }
    await postAsGranter(
      grant,
      approval.agentId,
      payload.text,
      approval.conversationId,
    );
    await auditSend(grant, approval.agentId, "sent", approval.id);
    return `Sent to ${grantName(grant)}.`;
  },
  {
    decidedBy: granterOf,
    resumeOnExecute: true,
    supersedeKey: heldMessageKey,
  },
);

registerActionHandler(
  SLACK_EDIT_ACTION,
  async (approval) => {
    const payload = heldEditPayload.parse(approval.payload);
    const grant = await reloadOwnMessage(approval.agentId, payload);
    await performEdit(
      grant,
      approval.agentId,
      payload.messageTs,
      payload.text,
      approval.conversationId,
    );
    await auditOwnMessage(
      grant,
      approval.agentId,
      "edit",
      "done",
      payload.messageTs,
      approval.id,
    );
    return `Edited the message in ${grantName(grant)}.`;
  },
  {
    decidedBy: granterOf,
    resumeOnExecute: true,
    supersedeKey: heldMessageKey,
  },
);

registerActionHandler(
  SLACK_DELETE_ACTION,
  async (approval) => {
    const payload = heldOwnPayload.parse(approval.payload);
    const grant = await reloadOwnMessage(approval.agentId, payload);
    await performDelete(grant, approval.agentId, payload.messageTs);
    await auditOwnMessage(
      grant,
      approval.agentId,
      "delete",
      "done",
      payload.messageTs,
      approval.id,
    );
    return `Deleted the message in ${grantName(grant)}.`;
  },
  {
    decidedBy: granterOf,
    resumeOnExecute: true,
    supersedeKey: heldMessageKey,
  },
);

registerActionHandler(
  SLACK_ACCESS_ACTION,
  async (approval) => {
    const p = slackAccessPayloadSchema.parse(approval.payload);
    if (CONNECT_REASONS.has(p.reason)) {
      throw new Error("This request resolves when they connect their Slack.");
    }
    const presence = await toolPresence(approval.agentId);
    if (!presence) throw new Error("The agent's Slack app isn't active.");
    const reader = await readerToken(
      presence,
      approval.agentId,
      p.readerUserId,
    );
    if (!reader?.mine) throw new Error("Their Slack isn't connected anymore.");
    if (p.kind === "write" && !reader.mine.canWrite) {
      throw new Error(NEEDS_RECONNECT_FOR_WRITE);
    }
    // Re-resolve with THEIR token now: it must still be one conversation
    // they are in (never trust the frozen ref alone). A frozen id is the
    // target; a bare name is a read's, matched as reads are.
    const asked: Asked = p.conversationRef
      ? { name: p.conversationRef, ref: p.conversationRef, exact: true }
      : { name: p.conversationQuery ?? "", exact: p.kind === "write" };
    const found = await resolveOwnConversation(reader.mine, asked);
    if (found.kind !== "one") {
      throw new Error(
        found.kind === "none"
          ? `No conversation of theirs matches ${p.conversationLabel ?? asked.name} anymore.`
          : unresolved(found, asked, p.kind),
      );
    }
    const saved = await saveGrant(
      reader.row.id,
      found.item,
      p.kind === "read" ? { readMode: "allow" } : { writeMode: "allow" },
    );
    rerender(approval.agentId);
    const grant = await db.agentReadGrant.findUniqueOrThrow({
      where: { id: saved.id },
      select: toolGrantSelect,
    });
    if (p.kind === "read") {
      const outcome = await performRead(presence, grant, approval.agentId, {});
      if (!outcome.ok) throw new Error(outcome.error);
      return `Access granted. The read result (JSON): ${JSON.stringify(outcome.result)}`.slice(
        0,
        HELD_READ_NOTE_MAX,
      );
    }
    if (!p.text) return `Writing in ${grantName(grant)} is now allowed.`;
    await postAsGranter(
      grant,
      approval.agentId,
      p.text,
      approval.conversationId,
    );
    await auditSend(grant, approval.agentId, "sent", approval.id);
    return {
      note: `Writing allowed; sent to ${grantName(grant)}.`,
      resume: `Sent as you to ${grantName(grant)}: "${cleanLabel(p.text, 200)}". Already delivered: don't send it again. Confirm in one short line and continue the original request.`,
    };
  },
  {
    decidedBy: (payload) => {
      const p = slackAccessPayloadSchema.safeParse(payload);
      return p.success
        ? {
            userId: p.data.readerUserId,
            externalUserId: p.data.readerExternalUserId ?? "",
          }
        : null;
    },
    // A connect request can't be done from Slack: its DM card is a link to
    // the agent's Contacts, which starts the connect flow on arrival.
    dmLink: (payload, ctx) => {
      const p = slackAccessPayloadSchema.safeParse(payload);
      if (!p.success || !CONNECT_REASONS.has(p.data.reason)) return null;
      return {
        url: dashboardUrl(
          `/agents/${encodeURIComponent(ctx.agentId)}/contacts?connect=slack`,
          { workspaceId: ctx.workspaceId },
        ),
        label:
          p.data.reason === "reconnect_for_write"
            ? "Reconnect your Slack"
            : "Connect your Slack",
        note: "Connecting happens in OneCLI; the agent continues once you do.",
      };
    },
    // Connect asks: one per person. Access asks: one per person, kind and
    // conversation.
    supersedeKey: (payload) => {
      const p = slackAccessPayloadSchema.safeParse(payload);
      if (!p.success) return null;
      return CONNECT_REASONS.has(p.data.reason)
        ? `${p.data.readerUserId}|connect`
        : [
            p.data.readerUserId,
            "access",
            p.data.kind,
            p.data.conversationRef ?? normalize(p.data.conversationQuery ?? ""),
          ].join("|");
    },
    approvable: (payload) => {
      const p = slackAccessPayloadSchema.safeParse(payload);
      return p.success && CONNECT_REASONS.has(p.data.reason)
        ? "Connect your Slack from the card in the chat; this request completes when you do."
        : true;
    },
    noteMaxChars: HELD_READ_NOTE_MAX,
    // Connecting (or allowing) wakes the asking chat: the agent retries.
    resumeOnExecute: true,
  },
);

/**
 * Messages (oldest first) as the model reads them: author names resolved
 * (OUR name for a linked teammate, the agent's for itself, else the Slack
 * profile name), mentions decoded, each text capped, and the whole result
 * kept under the tool-result budget by dropping the OLDEST messages first.
 */
const renderMessages = async (
  presence: {
    id: string;
    identityRef: string | null;
    credentials: string | null;
    agent: { name: string };
  },
  messages: SlackHistoryMessage[],
) => {
  const links = await db.channelUserLink.findMany({
    where: { integration: { agentChannels: { some: { id: presence.id } } } },
    select: {
      externalUserId: true,
      user: { select: { name: true, email: true } },
    },
  });
  const linked = new Map(
    links.map((l) => [l.externalUserId, l.user.name || l.user.email]),
  );
  const authorIds = [
    ...new Set(messages.flatMap((m) => (m.user ? [m.user] : []))),
  ].filter((id) => id !== presence.identityRef && !linked.has(id));
  const { botToken } = await appCredentials(presence.credentials);
  const profiles = await peopleNames(botToken, authorIds);
  const personName = (id: string): string | null =>
    id === presence.identityRef
      ? presence.agent.name
      : (linked.get(id) ?? profiles.get(id) ?? null);

  let budget = MAX_RESULT_TEXT_CHARS;
  let truncated = false;
  const out: {
    id: string;
    author: string;
    at: string;
    text: string;
    inThread?: string;
    replies?: number;
  }[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    let text = await decodeSlackTokens(m.text ?? "", async (id) =>
      personName(id),
    ).catch(() => m.text ?? "");
    if (text.length > MAX_MESSAGE_CHARS) {
      text = `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]`;
    }
    if (text.length > budget) {
      truncated = true;
      break;
    }
    budget -= text.length;
    out.unshift({
      id: m.ts,
      author: m.user
        ? (personName(m.user) ?? "Unknown member")
        : (m.username ?? "bot"),
      at: new Date(Number(m.ts) * 1000).toISOString(),
      text,
      ...(m.thread_ts && m.thread_ts !== m.ts && { inThread: m.thread_ts }),
      ...((m.reply_count ?? 0) > 0 && { replies: m.reply_count }),
    });
  }
  return { out, truncated };
};
