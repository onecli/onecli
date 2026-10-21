import { db, type Prisma } from "@onecli/db";
import {
  authRevoke,
  conversationsHistory,
  conversationsReplies,
  decodeSlackTokens,
  oauthUserAccess,
  SlackApiError,
  userConversationInfo,
  usersConversations,
  usersInfo,
  usersList,
  type SlackHistoryMessage,
  type SlackUserConversation,
} from "@onecli/channels/slack";
import { isDeadCredentialError } from "@onecli/channels";
import { getCrypto } from "../../providers";
import type { ConversationReader } from "../../providers/hooks/conversation-reader";
import { ServiceError } from "../../services/errors";
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
 *  2. The grant's AUDIENCE must admit the turn's reader. `granter_only` =
 *     only the granter's own direct thread, or a schedule they created that
 *     reports privately; any shared conversation (a channel thread, a peer
 *     agent, a guest) reads as nobody, even when the granter is the one
 *     asking there.
 *  3. Live: the read uses the granter's token, so Slack itself refuses a
 *     conversation they have since left.
 *
 * Read-only by construction: the module holds no send path and the scopes
 * carry no write.
 */

const log = logger.child({ component: "slack-read" });

export const READ_AUDIENCES = ["anyone", "granter_only"] as const;
type ReadAudience = (typeof READ_AUDIENCES)[number];

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

const decryptUserToken = async (encrypted: string): Promise<string | null> => {
  try {
    const raw: unknown = JSON.parse(await getCrypto().decrypt(encrypted));
    if (raw && typeof raw === "object" && "accessToken" in raw) {
      const { accessToken } = raw;
      return typeof accessToken === "string" && accessToken
        ? accessToken
        : null;
    }
    return null;
  } catch {
    return null;
  }
};

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
    authed_user: { id: string; access_token: string };
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
  const credentials = await getCrypto().encrypt(
    JSON.stringify({ accessToken: person.access_token }),
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
  const accessToken = await decryptUserToken(token.credentials);
  if (!accessToken) {
    throw new ServiceError("UNPROCESSABLE", "Reconnect your Slack.");
  }
  return {
    presence,
    token: { id: token.id, agentId: input.agentId },
    accessToken,
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
const listConversationsFor = async (
  mine: Awaited<ReturnType<typeof requireMyToken>>,
): Promise<MyConversation[]> => {
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
    .map((c) => ({ ref: c.id, kind: kindOf(c), name: displayName(c, names) }))
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
  audience: true,
  userToken: {
    select: { user: { select: { id: true, name: true, email: true } } },
  },
} as const satisfies Prisma.AgentReadGrantSelect;

type GrantWithGranter = Prisma.AgentReadGrantGetPayload<{
  select: typeof grantWithGranterSelect;
}>;

/** A grant as the dashboard sees it: who made it, and whether the viewer
 * did (only they may change its audience). */
const grantView = (
  { userToken, ...grant }: GrantWithGranter,
  viewer: string,
) => ({
  ...grant,
  grantedBy: userToken.user,
  mine: userToken.user.id === viewer,
});
type ReadGrantView = ReturnType<typeof grantView>;

/** Write one grant under the caller's token; label and kind come from
 * Slack, never from the client. */
const saveGrant = (
  tokenId: string,
  conversation: MyConversation,
  audience: ReadAudience,
) => {
  const fields = {
    subjectKind: conversation.kind,
    subjectLabel: conversation.name,
    audience,
  };
  return db.agentReadGrant.upsert({
    where: {
      userTokenId_externalRef: {
        userTokenId: tokenId,
        externalRef: conversation.ref,
      },
    },
    create: { userTokenId: tokenId, externalRef: conversation.ref, ...fields },
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
  audience: ReadAudience;
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
    picked.map((c) => saveGrant(mine.token.id, c, input.audience)),
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
  audience: ReadAudience;
}): Promise<ReadGrantView> => {
  const mine = await requireMyToken(input);
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
    { ref: input.externalRef, kind: kindOf(c), name: displayName(c, names) },
    input.audience,
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

/**
 * The `read_conversation` tool's body. Matches the model's name against the
 * agent's grants ONLY (never the workspace), applies the audience fence,
 * and reads with the GRANTER's token. A conversation the reader may not see
 * gets the same answer as one that does not exist.
 */
export const readConversation = async (
  input: ReadConversationInput,
): Promise<ReadConversationOutcome> => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, provider: "slack", status: "active" },
    select: {
      id: true,
      identityRef: true,
      credentials: true,
      agent: {
        select: { name: true, workspace: { select: { organizationId: true } } },
      },
    },
  });
  if (!presence) {
    return { ok: false, error: "You have no active Slack app to read with." };
  }
  await assertCanUseGranularAccess(presence.agent.workspace.organizationId);

  const grants = await db.agentReadGrant.findMany({
    where: { userToken: { agentChannelId: presence.id } },
    select: {
      externalRef: true,
      subjectLabel: true,
      audience: true,
      userToken: { select: { id: true, userId: true, credentials: true } },
    },
  });
  // The audience fence: "anyone" admits every turn, "granter_only" only
  // the verified reader who granted it (null reader = a shared audience).
  const visible = grants.filter(
    (g) =>
      g.audience === "anyone" ||
      (input.readerUserId !== null &&
        g.userToken.userId === input.readerUserId),
  );
  const nameOf = (g: (typeof visible)[number]) =>
    g.subjectLabel ?? g.externalRef;
  const asked = (input.conversation ?? "").trim();
  const wanted = normalize(asked);
  // No conversation named: list what THIS reader may read (the audience
  // fence already applied, so nobody learns of a share they can't use).
  if (!wanted) {
    return {
      ok: true,
      result: {
        readable: visible.map(nameOf),
        note:
          visible.length > 0
            ? "Call read_conversation again with one of these names."
            : "Nothing has been shared for you to read here.",
      },
    };
  }
  // Exact id or name first; then a unique partial match ("notif" finds
  // "#notifications"), so a near-miss name still reads instead of failing.
  const exact = visible.find(
    (g) =>
      g.externalRef === asked ||
      (g.subjectLabel !== null && normalize(g.subjectLabel) === wanted),
  );
  const partial = exact
    ? []
    : visible.filter(
        (g) =>
          g.subjectLabel !== null && normalize(g.subjectLabel).includes(wanted),
      );
  const grant = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (!grant) {
    const names = visible.map(nameOf);
    return {
      ok: false,
      error: `You don't have read access to ${asked} in this conversation.${
        names.length > 0
          ? ` Conversations you may read here: ${names.join(", ")}.`
          : " You have no readable conversations here."
      } Access is granted per conversation by people who connected their Slack on the agent's Slack page.`,
    };
  }
  const label = nameOf(grant);

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
