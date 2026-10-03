import { isDeadCredentialError } from "@onecli/channels";
import { randomBytes, randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import {
  flattenToLine,
  MAX_AGENT_CHANNEL_PRESENCES,
  type AgentChannelPresenceWire,
} from "@onecli/agent-protocol";
import { getCrypto, getRoleResolver, ROLE_HIERARCHY } from "../../providers";
import {
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from "../../lib/oauth-state";
import { ServiceError } from "../errors";
import { createServiceApiKey, revokeServiceApiKey } from "../api-key-service";
import { bumpHomeForAgent } from "../home-sync-service";
import { channelProvider, isChannelProviderId } from "./registry";
import {
  listPersonGrants,
  listSpaceGrants,
  type ReachState,
} from "./agent-reach-service";
import {
  availableTransports,
  defaultTransport,
  publicApiUrl,
  resolveTransport,
} from "./posture";
import {
  assertChannelIdentityAvailable,
  assertChannelLifecycleHeld,
  beginChannelReattach,
  enqueueChannelCleanup,
  lockAgentRow,
  lockChannelLifecycle,
  preserveUnattachedChannelApp,
  processChannelCleanups,
  withChannelLifecycle,
} from "./channel-cleanup-service";
import { withFreshIntegrationCredentials } from "./channel-integration-service";
import type {
  ChannelAppMode,
  ChannelProviderId,
  ChannelTransport,
  PresenceIdentity,
} from "./types";
import { CAPS, RUNNER_ONLINE_THRESHOLD_SECONDS } from "../../lib/env";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "agent-channel-service" });

/**
 * The per-agent channel presence lifecycle (attach → active → detach).
 *
 * Two completion doors, one activation core: the socket arm and the paste
 * floor complete with pasted tokens (`completePresence`); the events arm
 * completes when the OAuth callback lands (`completePresenceFromOAuth`).
 * Both converge on `activatePresence`, which resolves the integration row,
 * stores credentials, and mints the approvals service key.
 */

/** How long an install link (the signed OAuth state) stays valid. */
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;

// ── The renderer's view: what the agent is told about its own presences ─────

/** The wire's own caps, applied after the control-strip so a clamp can never
 * reveal a stripped byte's worth of extra text. */
const HANDLE_MAX = 80;
const WORKSPACE_NAME_MAX = 120;

/** Display text that lands inside platform voice: control-stripped,
 * single-line, clamped; empty becomes null (the renderer falls back). */
const renderText = (raw: string | null, max: number): string | null => {
  if (raw === null) return null;
  const clean = flattenToLine(raw).slice(0, max);
  return clean.length > 0 ? clean : null;
};

/**
 * The agent's channel presences as the supervisor's `channels` capability
 * needs them (plans/channel-aware-agents.md): one entry per non-pending
 * presence with the provider, the bot's own handle, the tenant's display
 * name, and whether it is live. Read at DISPATCH by the spawn-payload and
 * home-sync composers (the "current truth" law), so an attach, a detach, or
 * a provider-side removal is what the agent reads next.
 *
 * Display facts only — no ids, no credentials — and every string is
 * user/provider supplied, so it is cleaned here before it can ride into the
 * instruction doc. `pending_setup` rows are skipped: a half-finished attach
 * is not a place the agent can be reached. Ordered by provider so the
 * rendered doc is stable across dispatches.
 */
export const channelPresencesForRender = async (
  agentId: string,
): Promise<AgentChannelPresenceWire[]> => {
  const rows = await db.agentChannel.findMany({
    where: { agentId, status: { not: "pending_setup" } },
    select: {
      provider: true,
      status: true,
      identityName: true,
      integration: { select: { name: true } },
    },
    orderBy: { provider: "asc" },
    // One presence per (agent, provider) by constraint, so this cap is
    // unreachable today; it pins the wire schema's bound regardless of what
    // a future provider or constraint change allows.
    take: MAX_AGENT_CHANNEL_PRESENCES,
  });
  const presences: AgentChannelPresenceWire[] = [];
  for (const row of rows) {
    // The status vocabulary is ours, but the column is a free string; a
    // value this build does not know is dropped rather than misdescribed.
    if (
      row.status !== "active" &&
      row.status !== "needs_attention" &&
      row.status !== "disabled"
    ) {
      continue;
    }
    presences.push({
      provider: row.provider,
      status: row.status,
      handle: renderText(row.identityName, HANDLE_MAX),
      workspaceName: renderText(row.integration.name, WORKSPACE_NAME_MAX),
    });
  }
  return presences;
};

/**
 * Re-render a live sandbox's instruction doc after a presence changed — the
 * same bump a brief edit takes (agent-service.ts: "a bump, never a
 * respawn"). Fire-and-forget from the lifecycle writes: the presence write
 * already committed, and a bump failure must not turn a successful attach
 * or detach into an error. A parked sandbox needs no bump; its next boot
 * composes the payload from current truth.
 */
const rerenderAgentHome = (agentId: string): void => {
  void bumpHomeForAgent(agentId).catch((err: unknown) =>
    log.warn({ err, agentId }, "home bump after a presence change failed"),
  );
};

const presenceSelect = {
  id: true,
  provider: true,
  externalId: true,
  identityRef: true,
  identityName: true,
  transport: true,
  status: true,
  apiKeyId: true,
  createdAt: true,
  // Deliberately NOT the integration's `credentials`: this select backs the
  // create/update RETURN value, which the complete route hands to the browser.
  // Even as ciphertext, an org automation credential must never leave the
  // server (the "credentials never leave the server" rule).
  integration: {
    select: { id: true, externalId: true, name: true },
  },
  // The attaching member — the "Managed by" line on the presence card.
  createdBy: { select: { name: true, email: true } },
} as const;

/**
 * Resolve display labels for spaces whose grant row has none, and persist
 * what we learn.
 *
 * Why this exists: a space row can be born without a label (created before
 * the bot could read the channel, or by a path holding no credentials), and
 * a bare `C0A1B2C3` tells nobody which room they are opening their agent to.
 *
 * Bounded and failure-proof by construction: it only runs for rows actually
 * missing a label, it fetches the integration credentials itself (they are
 * kept out of `presenceSelect` on purpose - they must never ride a response
 * to the browser), and any provider failure leaves the id showing rather
 * than breaking the page. The write-back is best-effort too: the next read
 * simply tries again.
 */
const hydrateSpaceLabels = async (input: {
  reach: NonNullable<ReturnType<typeof channelProvider>["reach"]>;
  spaces: { externalRef: string; label: string | null }[];
  agentId: string;
  integrationId: string;
}): Promise<void> => {
  const missing = input.spaces.filter((s) => s.label === null);
  if (missing.length === 0) return;

  const integration = await db.channelIntegration.findUnique({
    where: { id: input.integrationId },
    select: { credentials: true },
  });
  if (!integration?.credentials) return;
  const credentialsJson = await getCrypto()
    .decrypt(integration.credentials)
    .catch(() => null);
  if (!credentialsJson) return;

  await Promise.all(
    missing.map(async (space) => {
      const label = await input.reach
        .spaceLabel({ credentialsJson, externalRef: space.externalRef })
        .catch(() => null);
      if (!label) return;
      space.label = label;
      // Write back so this costs one lookup per space, not one per view.
      // `updateMany` (not `update`): the row may not exist yet for a
      // thread-derived space, and a no-op update is the correct outcome.
      await db.agentReachGrant
        .updateMany({
          where: {
            agentId: input.agentId,
            integrationId: input.integrationId,
            subjectKind: "space",
            externalRef: space.externalRef,
            subjectLabel: null,
          },
          data: { subjectLabel: label },
        })
        .catch(() => undefined);
    }),
  );
};

/** The agent fence every entry point shares — workspace-scoped, hosted-only. */
const requireHostedAgent = async (workspaceId: string, agentId: string) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      name: true,
      kind: true,
      workspace: { select: { id: true, organizationId: true } },
    },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted") {
    throw new ServiceError(
      "UNPROCESSABLE",
      "Only hosted agents can join channels",
    );
  }
  return agent;
};

export interface AgentChannelStatus {
  provider: ChannelProviderId;
  status: string;
  transport: ChannelTransport;
  externalId: string;
  identityRef: string | null;
  /** The app's handle in the workspace (Slack: "donna"), where we know it. */
  identityName: string | null;
  tenant: { externalId: string; name: string | null };
  /** The member who attached this presence, for the "Managed by" line. */
  managedBy: { name: string | null; email: string } | null;
  /** Group threads the presence is live in (direct DMs stay private). */
  groupThreads: { externalThreadId: string; createdAt: Date }[];
  /** Per-space reach: every channel the presence is in or was asked about,
   * with its grant state. `members_only` = no grant row (today's default).
   * The union of grant rows and the live thread links' spaces, so a channel
   * the agent merely sits in still gets a row the toggle can act on. */
  spaces: {
    externalRef: string;
    label: string | null;
    state: ReachState | "members_only";
    decidedAt: Date | null;
  }[];
  /** Per-PERSON reach: everyone who knocked by direct message, with their
   * standing. Only ever grant rows - unlike spaces there is nothing to
   * union in, because a DM leaves no "the agent merely sits here" trace. */
  people: {
    externalRef: string;
    label: string | null;
    state: ReachState;
    decidedAt: Date | null;
  }[];
}

export interface AgentChannelsView {
  presences: AgentChannelStatus[];
  /** What an attach would use right now, and what it could choose instead. */
  posture: { transport: ChannelTransport; available: ChannelTransport[] };
  /** The org the agent's workspace belongs to — the deep-link target for
   * "connect Slack at the org level" when no credential exists yet. */
  organizationId: string;
  /** Can the CALLER open that deep-link target? The org Channels page sits
   * behind the admin layout, which silently bounces non-admins — so the
   * empty state renders the link only for admins and tells members to ask
   * one instead. True wherever roles aren't enforced. */
  viewerIsOrgAdmin: boolean;
  /** Per provider: does the org hold an automation credential? */
  orgIntegrations: {
    provider: ChannelProviderId;
    connected: boolean;
    hasCredentials: boolean;
  }[];
  adapter: { online: boolean; lastSeenAt: Date | null };
}

/**
 * Fill in the handle of any presence that lacks one, using its own stored
 * credential. Presences created before the column existed have none, and the
 * delete confirmation wants to name the app a human recognizes rather than
 * fall back to its opaque id.
 *
 * Scoped to a single agent and driven by the Channels page, which is the one
 * place a presence is looked at directly — deliberately NOT the agents list,
 * where it would put a fan-out of Slack calls on a hot read. Internally
 * failure-proof, and only ever writes a name onto a row that has none, so it
 * cannot fight a rename captured at completion.
 */
export const backfillIdentityNames = async (agentId: string): Promise<void> => {
  const rows = await db.agentChannel.findMany({
    where: { agentId, identityName: null, credentials: { not: null } },
    select: { id: true, provider: true, credentials: true },
  });

  for (const row of rows) {
    try {
      const provider = channelProvider(row.provider as ChannelProviderId);
      if (!provider.fetchIdentityName || !row.credentials) continue;
      const name = await provider.fetchIdentityName({
        credentialsJson: await getCrypto().decrypt(row.credentials),
      });
      if (!name) continue;
      await db.agentChannel.updateMany({
        where: { id: row.id, identityName: null },
        data: { identityName: name },
      });
    } catch (err) {
      log.debug({ err, presenceId: row.id }, "identity-name backfill skipped");
    }
  }
};

export const getAgentChannels = async (
  workspaceId: string,
  agentId: string,
  viewerUserId?: string,
): Promise<AgentChannelsView> => {
  const agent = await requireHostedAgent(workspaceId, agentId);

  // Whether the CALLER may take the "connect Slack for the org" deep link
  // (it sits behind the org admin layout). RBAC off = no roles = everyone
  // may; no viewer identity (service callers, older tests) = same.
  let viewerIsOrgAdmin = true;
  if (CAPS.rbac && viewerUserId) {
    const resolver = getRoleResolver();
    const role = resolver
      ? await resolver.getUserRole(viewerUserId, agent.workspace.organizationId)
      : null;
    viewerIsOrgAdmin =
      role !== null && ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin;
  }

  // The Channels section is where a presence is looked at, so it is the
  // natural place to fill in a handle we never captured. Awaited so the same
  // response carries it; internally failure-proof.
  await backfillIdentityNames(agent.id);

  const [presences, integrations, adapter] = await Promise.all([
    db.agentChannel.findMany({
      where: { agentId: agent.id },
      select: {
        ...presenceSelect,
        threadLinks: {
          where: { kind: "group" },
          select: { externalThreadId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.channelIntegration.findMany({
      where: { organizationId: agent.workspace.organizationId },
      select: { provider: true, credentials: true },
    }),
    db.channelAdapter.findFirst({
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    }),
  ]);

  return {
    presences: await Promise.all(
      presences.map(async (p) => {
        const provider = p.provider as ChannelProviderId;
        // The per-space reach rows: grant rows first (they carry state and
        // label), then any live thread's space with no row yet, shown as
        // today's default (`members_only`) so the toggle can act on it.
        const reach = channelProvider(provider).reach;
        const grants = reach ? await listSpaceGrants(agent.id, provider) : [];
        // The People section's rows. Same ledger, different subject kind.
        const people = reach
          ? (await listPersonGrants(agent.id, provider)).map((g) => ({
              externalRef: g.externalRef,
              label: g.subjectLabel,
              state: g.state,
              decidedAt: g.decidedAt,
            }))
          : [];
        const spaces = grants.map((g) => ({
          externalRef: g.externalRef,
          label: g.subjectLabel,
          state: g.state as ReachState,
          decidedAt: g.decidedAt,
        }));
        if (reach) {
          const known = new Set(spaces.map((s) => s.externalRef));
          for (const link of p.threadLinks) {
            const space = reach.spaceOf(link.externalThreadId);
            if (!space || known.has(space)) continue;
            known.add(space);
            spaces.push({
              externalRef: space,
              label: null,
              // Not yet settled: this channel has live threads but no
              // decision, which is exactly `pending` under the precondition
              // model - never silently "members_only".
              state: "pending",
              decidedAt: null,
            });
          }
          // Fill the labels the grant rows lack. A row created before the
          // bot could read the channel name (or by a path that had no
          // credentials in hand) stores null, and the raw `C0…` id is
          // meaningless to a human deciding who may talk to their agent.
          // Resolved here on read, then written back so the lookup is a
          // one-time cost per space rather than per page view.
          await hydrateSpaceLabels({
            reach,
            spaces,
            agentId: agent.id,
            integrationId: p.integration.id,
          });
        }
        return {
          provider,
          status: p.status,
          transport: p.transport as ChannelTransport,
          externalId: p.externalId,
          identityRef: p.identityRef,
          identityName: p.identityName,
          tenant: {
            externalId: p.integration.externalId,
            name: p.integration.name,
          },
          managedBy: p.createdBy
            ? { name: p.createdBy.name, email: p.createdBy.email }
            : null,
          groupThreads: p.threadLinks,
          spaces,
          people,
        };
      }),
    ),
    posture: {
      transport: defaultTransport(),
      available: availableTransports(),
    },
    organizationId: agent.workspace.organizationId,
    viewerIsOrgAdmin,
    // `hasCredentials` is "can this org mint agent apps right now" — true on
    // a pasted automation credential OR on a shared install carrying the
    // mint credential (the managed-apps arm, via the provider's sharedApp
    // facet). The UI keys every one-click flow off it, so the OR is what
    // makes the shared install light them up.
    orgIntegrations: await Promise.all(
      integrations.map(async (i) => {
        const provider = i.provider as ChannelProviderId;
        return {
          provider,
          connected: true,
          hasCredentials:
            i.credentials !== null ||
            ((await channelProvider(provider).sharedApp?.canMintApps(
              agent.workspace.organizationId,
            )) ??
              false),
        };
      }),
    ),
    adapter: {
      online: adapter?.lastSeenAt ? isAdapterOnline(adapter.lastSeenAt) : false,
      lastSeenAt: adapter?.lastSeenAt ?? null,
    },
  };
};

/** Same liveness window the runner uses — one vocabulary for "offline". */
const isAdapterOnline = (lastSeenAt: Date): boolean =>
  Date.now() - lastSeenAt.getTime() < RUNNER_ONLINE_THRESHOLD_SECONDS * 1000;

/** The paste floor's step 0: the provider's setup document. */
export const getSetupMaterial = async (
  workspaceId: string,
  agentId: string,
  provider: ChannelProviderId,
  requestedTransport?: ChannelTransport,
) => {
  const agent = await requireHostedAgent(workspaceId, agentId);
  const transport = resolveTransport(requestedTransport);
  return {
    transport,
    material: channelProvider(provider).buildSetupMaterial({
      agentName: agent.name,
      transport,
      publicApiUrl: publicApiUrl(),
    }),
  };
};

export interface CreatePresenceResult {
  presenceId: string;
  transport: ChannelTransport;
  /** Events arm: the one-click consent URL. */
  installUrl: string | null;
  /** Socket arm: where the app-level token is generated + Install lives. */
  settingsUrl: string;
}

/**
 * A presence row the attach flow may RESUME rather than refuse: a
 * half-finished attach (`pending_setup`) or an app the workspace removed on
 * the provider side (`disabled`, see `markPresenceRemoved`). Both keep the
 * same app id and client credentials, so re-attaching is one consent click
 * (events) or one token paste (socket) onto the existing app — never a
 * sibling app. Every other status is a live presence: detach first.
 */
const isResumableStatus = (status: string): boolean =>
  status === "pending_setup" || status === "disabled";

/**
 * The guided arm: create the provider app from the org's automation
 * credential. The presence row is persisted `pending_setup` the moment the
 * remote app exists, so a half-finished attach is tracked, resumable, and
 * never an orphan only Slack knows about.
 */
const createPresenceUnlocked = async (
  workspaceId: string,
  agentId: string,
  provider: ChannelProviderId,
  actorUserId: string,
  requestedTransport?: ChannelTransport,
): Promise<CreatePresenceResult> => {
  const agent = await requireHostedAgent(workspaceId, agentId);
  const organizationId = agent.workspace.organizationId;

  const existing = await db.agentChannel.findUnique({
    where: { agentId_provider: { agentId: agent.id, provider } },
    select: {
      id: true,
      status: true,
      externalId: true,
      transport: true,
      appMode: true,
      credentials: true,
      apiKeyId: true,
    },
  });
  if (existing && !isResumableStatus(existing.status)) {
    throw new ServiceError(
      "CONFLICT",
      `This agent already has a ${channelProvider(provider).displayName} app. Detach it first.`,
    );
  }
  if (
    existing &&
    requestedTransport &&
    requestedTransport !== existing.transport
  ) {
    throw new ServiceError(
      "CONFLICT",
      "Setup already started with a different connection mode. Start over to switch.",
    );
  }

  // A resumed attach stays on the row's stamp (the provider-side app config
  // baked it in); only a fresh create consults the request and the posture.
  // The OAuth state is minted per that transport — mint it off the current
  // default and a socket resume would carry a useless state while an events
  // resume under a changed posture would lose its install URL.
  const transport = existing
    ? (existing.transport as ChannelTransport)
    : resolveTransport(requestedTransport);
  // Same stamp law for the app flavor: a resumed attach keeps the flavor its
  // manifest was created with (`agent_view` is already baked in remotely and
  // is irreversible); a fresh create is always agent-flavored.
  const appMode: ChannelAppMode = existing
    ? (existing.appMode as ChannelAppMode)
    : "agent";
  const oauthState =
    transport === "events"
      ? signOAuthState({
          provider,
          nonce: randomBytes(16).toString("hex"),
          kind: "channel-install",
          agentId: agent.id,
          workspaceId,
          issuedAt: Date.now(),
        })
      : null;

  // A pending row from an interrupted attach: resume it when it still can
  // finish (same transport as today's posture, and its consent URL still
  // rebuilds), else SELF-HEAL — snapshot the stale row for durable remote
  // cleanup, delete it, and mint fresh in this same click. The user never
  // manages half-finished state; the button always works. The remote half is
  // NOT run here: this is an attach, already inside the lifecycle lock and
  // about to spend its budget on the provider create; the maintenance pass
  // picks the snapshot up. The identity lock inside the enqueue fences the
  // row; the lifecycle lock is held by the wrapper on its own connection.
  if (existing) {
    if (existing.transport === transport) {
      const urls = await rebuildSetupUrls(provider, existing.id, oauthState);
      const resumable =
        transport === "events" ? urls.installUrl !== null : true;
      if (resumable) {
        return { presenceId: existing.id, transport, ...urls };
      }
    }
    log.info(
      { agentId: agent.id, provider, presenceId: existing.id },
      "discarding a stale pending setup and starting fresh",
    );
    await db.$transaction(async (tx) => {
      await enqueueChannelCleanup(tx, { id: existing.id });
      await tx.agentChannel.delete({ where: { id: existing.id } });
    });
  }

  return withFreshIntegrationCredentials(
    organizationId,
    provider,
    async (accessToken, integrationId) => {
      // The attaching member's identity rides into the app's About text so
      // teammates in Slack know whose agent this is and who to ask.
      const actor = await db.user.findUnique({
        where: { id: actorUserId },
        select: { name: true, email: true },
      });
      const integrationSnapshot = await db.channelIntegration.findFirstOrThrow({
        where: { id: integrationId, organizationId, provider },
        select: { externalId: true },
      });
      const presenceId = randomUUID();
      await assertChannelLifecycleHeld();
      const created = await channelProvider(provider).createManagedPresence({
        accessToken,
        agentName: agent.name,
        transport,
        publicApiUrl: publicApiUrl(),
        oauthState,
        owner: actor ? { name: actor.name, email: actor.email } : null,
      });
      const encrypted = await getCrypto().encrypt(created.credentialsJson);
      const row = await db
        .$transaction(async (tx) => {
          await assertChannelLifecycleHeld();
          await lockAgentRow(tx, agent.id);
          await assertChannelIdentityAvailable(
            tx,
            provider,
            created.externalId,
          );
          return tx.agentChannel.create({
            data: {
              id: presenceId,
              agentId: agent.id,
              integrationId,
              provider,
              externalId: created.externalId,
              transport,
              appMode,
              credentials: encrypted,
              status: "pending_setup",
              createdByUserId: actorUserId,
            },
            select: { id: true },
          });
        })
        .catch(async (error: unknown) => {
          // The user's error is the write failure; a compensation that
          // itself fails (an identity mismatch, a DB blip) is logged, not
          // surfaced over it. The app is then an orphan Slack knows about
          // and we do not, which is exactly what the log line is for.
          await preserveUnattachedChannelApp({
            organizationId,
            workspaceId,
            integrationId,
            teamId: integrationSnapshot.externalId,
            sourcePresenceId: presenceId,
            provider,
            externalId: created.externalId,
            credentials: encrypted,
          }).catch((snapshotError: unknown) =>
            log.error(
              { err: snapshotError, provider, appId: created.externalId },
              "remote app created but its compensation snapshot failed; manual cleanup required",
            ),
          );
          throw error;
        });
      return {
        presenceId: row.id,
        transport,
        installUrl: created.installUrl,
        settingsUrl: created.settingsUrl,
      };
    },
  );
};

/** Rebuild install/settings URLs for a resumed pending attach — provider-
 * dispatched: the URLs are provider-shaped, and only the provider knows the
 * full scope list its consent URL must grant. */
const rebuildSetupUrls = async (
  provider: ChannelProviderId,
  presenceId: string,
  oauthState: string | null,
): Promise<{ installUrl: string | null; settingsUrl: string }> => {
  const row = await db.agentChannel.findUniqueOrThrow({
    where: { id: presenceId },
    select: {
      id: true,
      externalId: true,
      transport: true,
      appMode: true,
      credentials: true,
    },
  });
  await db.$transaction((tx) =>
    beginChannelReattach(tx, provider, row.externalId, row.id),
  );
  const credentialsJson = row.credentials
    ? await getCrypto().decrypt(row.credentials)
    : null;
  return channelProvider(provider).rebuildSetupUrls({
    externalId: row.externalId,
    transport: row.transport as ChannelTransport,
    appMode: row.appMode as ChannelAppMode,
    credentialsJson,
    oauthState,
  });
};

/**
 * The shared activation core both completion doors land on: bind the
 * integration row (paste floor may be minting it, credential-less), store
 * the presence's credentials, and mint the approvals service key.
 */
const activatePresence = async (input: {
  presenceId: string | null;
  agent: { id: string; name: string; workspaceId: string };
  organizationId: string;
  provider: ChannelProviderId;
  transport: ChannelTransport;
  appMode: ChannelAppMode;
  externalId: string;
  identity: PresenceIdentity;
  credentialsJson: string;
  actorUserId: string;
}) => {
  await assertChannelLifecycleHeld();
  const integration = await db.channelIntegration.findUnique({
    where: {
      organizationId_provider: {
        organizationId: input.organizationId,
        provider: input.provider,
      },
    },
    select: { id: true, externalId: true, name: true },
  });

  if (
    integration &&
    integration.externalId !== input.identity.tenant.externalId
  ) {
    throw new ServiceError(
      "CONFLICT",
      `This app belongs to a different ${channelProvider(input.provider).displayName} workspace than the one connected to your organization.`,
    );
  }

  const integrationId = integration
    ? integration.id
    : (
        await db.channelIntegration.create({
          data: {
            organizationId: input.organizationId,
            provider: input.provider,
            externalId: input.identity.tenant.externalId,
            name: input.identity.tenant.name,
            createdByUserId: input.actorUserId,
          },
          select: { id: true },
        })
      ).id;

  // Backfill the tenant name the config-token flow could not learn.
  if (integration && !integration.name && input.identity.tenant.name) {
    await db.channelIntegration.update({
      where: { id: integration.id },
      data: { name: input.identity.tenant.name },
    });
  }

  const serviceKey = await createServiceApiKey(
    input.actorUserId,
    { workspaceId: input.agent.workspaceId },
    `${channelProvider(input.provider).displayName} · ${input.agent.name}`,
  );

  const encrypted = await getCrypto().encrypt(input.credentialsJson);
  const data = {
    integrationId,
    externalId: input.externalId,
    identityRef: input.identity.identityRef,
    identityName: input.identity.identityName ?? null,
    transport: input.transport,
    appMode: input.appMode,
    credentials: encrypted,
    status: "active",
    apiKeyId: serviceKey.id,
  };

  try {
    const presence = await db.$transaction(async (tx) => {
      await assertChannelLifecycleHeld(0);
      await lockAgentRow(tx, input.agent.id);
      await assertChannelIdentityAvailable(
        tx,
        input.provider,
        input.externalId,
        input.presenceId,
      );
      return input.presenceId
        ? await tx.agentChannel.update({
            where: { id: input.presenceId },
            data,
            select: presenceSelect,
          })
        : await tx.agentChannel.create({
            data: {
              ...data,
              agentId: input.agent.id,
              provider: input.provider,
              createdByUserId: input.actorUserId,
            },
            select: presenceSelect,
          });
    });
    // The agent's instruction doc now has a channel to describe.
    rerenderAgentHome(input.agent.id);
    return presence;
  } catch (err) {
    // The presence write failed — don't strand the service key we just minted
    // (it is invisible to the personal-key flows and would otherwise be
    // orphaned with no owner-facing way to revoke it).
    await revokeServiceApiKey(serviceKey.id).catch(() => {});
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // The `(provider, externalId)` unique: this provider app is already
      // attached to another agent (or someone pasted a foreign app id).
      throw new ServiceError(
        "CONFLICT",
        `That ${channelProvider(input.provider).displayName} app is already connected to an agent. Each agent needs its own app.`,
      );
    }
    throw err;
  }
};

/**
 * The pasted-tokens completion door (socket arm + the whole paste floor).
 * `appId` is required when no guided create ran (the floor) — the events
 * inbound routes look presences up by it, and Slack shows it plainly on the
 * app's Basic Information page.
 */
const completePresenceUnlocked = async (
  workspaceId: string,
  agentId: string,
  provider: ChannelProviderId,
  input: {
    botToken: string;
    appToken?: string;
    signingSecret?: string;
    appId?: string;
    transport?: ChannelTransport;
  },
  actorUserId: string,
) => {
  const agent = await requireHostedAgent(workspaceId, agentId);

  const existing = await db.agentChannel.findUnique({
    where: { agentId_provider: { agentId: agent.id, provider } },
    select: {
      id: true,
      status: true,
      externalId: true,
      transport: true,
      appMode: true,
      credentials: true,
    },
  });
  if (existing && !isResumableStatus(existing.status)) {
    throw new ServiceError(
      "CONFLICT",
      `This agent already has a ${channelProvider(provider).displayName} app. Detach it first.`,
    );
  }
  if (existing && input.transport && input.transport !== existing.transport) {
    throw new ServiceError(
      "CONFLICT",
      "Setup already started with a different connection mode. Start over to switch.",
    );
  }

  // A pending row keeps its stamp (the provider-side app config baked it in);
  // only the floor's no-row paste consults the request and the posture.
  const transport = existing
    ? (existing.transport as ChannelTransport)
    : resolveTransport(input.transport);
  // The flavor follows the same stamp law. A floor paste with no pending row
  // is always agent-flavored — the same flavor `getSetupMaterial` baked into
  // the manifest the user just recreated by hand.
  const appMode: ChannelAppMode = existing
    ? (existing.appMode as ChannelAppMode)
    : "agent";

  const externalId = existing?.externalId ?? input.appId?.trim();
  if (!externalId) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The App ID is required. Copy it from the app's Basic Information page.",
    );
  }

  const existingJson = existing?.credentials
    ? await getCrypto().decrypt(existing.credentials)
    : null;

  await db.$transaction((tx) =>
    beginChannelReattach(tx, provider, externalId, existing?.id),
  );
  await assertChannelLifecycleHeld();
  const completed = await channelProvider(provider).completePresence({
    pasted: {
      botToken: input.botToken,
      ...(input.appToken && { appToken: input.appToken }),
      ...(input.signingSecret && { signingSecret: input.signingSecret }),
    },
    existingCredentialsJson: existingJson,
    transport,
  });

  return activatePresence({
    presenceId: existing?.id ?? null,
    agent: { id: agent.id, name: agent.name, workspaceId },
    organizationId: agent.workspace.organizationId,
    provider,
    transport,
    appMode,
    externalId,
    identity: completed.identity,
    credentialsJson: completed.credentialsJson,
    actorUserId,
  });
};

/**
 * The events arm's completion door — invoked by the OAuth callback route
 * after it verified the signed state. Resolves the pending presence by
 * (agent, provider) from the state payload, never from anything the browser
 * chose. `payload` is the verified state the lifecycle wrapper already
 * checked; the TTL and agent checks that need no lock happen here.
 */
const completePresenceFromOAuthUnlocked = async (
  input: { code: string; redirectUri: string },
  payload: OAuthStatePayload & { workspaceId: string },
) => {
  if (
    typeof payload.agentId !== "string" ||
    typeof payload.issuedAt !== "number" ||
    Date.now() - payload.issuedAt > OAUTH_STATE_TTL_MS
  ) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const provider = payload.provider as ChannelProviderId;

  const agent = await requireHostedAgent(payload.workspaceId, payload.agentId);
  const presence = await db.agentChannel.findUnique({
    where: { agentId_provider: { agentId: agent.id, provider } },
    select: {
      id: true,
      integrationId: true,
      integration: { select: { externalId: true } },
      status: true,
      externalId: true,
      transport: true,
      appMode: true,
      credentials: true,
      createdByUserId: true,
    },
  });
  if (
    !presence ||
    !isResumableStatus(presence.status) ||
    !presence.credentials
  ) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }

  // The attach belongs to whoever started it — the callback carries no
  // session of its own, and the approvals key must borrow a REAL user's
  // authority. If that user is gone, the link is dead; a fresh attach names
  // a new owner.
  if (!presence.createdByUserId) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }

  await db.$transaction((tx) =>
    beginChannelReattach(tx, provider, presence.externalId, presence.id),
  );
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  await assertChannelLifecycleHeld();
  const exchanged = await channelProvider(provider).exchangeOAuthCode({
    code: input.code,
    redirectUri: input.redirectUri,
    credentialsJson,
  });

  if (
    exchanged.identity.tenant.externalId !== presence.integration.externalId
  ) {
    throw new ServiceError(
      "CONFLICT",
      `This app belongs to a different ${channelProvider(provider).displayName} workspace than the one connected to your organization.`,
    );
  }
  // Preserve exchanged credentials before any subsequent service-key/activation
  // failure. Lifecycle serialization means teardown will snapshot this token.
  const encrypted = await getCrypto().encrypt(exchanged.credentialsJson);
  const snapshot = {
    organizationId: agent.workspace.organizationId,
    workspaceId: payload.workspaceId,
    integrationId: presence.integrationId,
    teamId: presence.integration.externalId,
    sourcePresenceId: presence.id,
    provider,
    externalId: presence.externalId,
    credentials: encrypted,
  };
  try {
    await assertChannelLifecycleHeld(0);
  } catch (error) {
    await preserveUnattachedChannelApp({ ...snapshot, retainAttached: true });
    throw error;
  }
  const saved = await db.agentChannel.updateMany({
    where: { id: presence.id },
    data: { credentials: encrypted },
  });
  if (!saved.count) {
    await preserveUnattachedChannelApp(snapshot);
    throw new ServiceError("CONFLICT", "This install is no longer attached");
  }
  const activated = await activatePresence({
    presenceId: presence.id,
    agent: { id: agent.id, name: agent.name, workspaceId: payload.workspaceId },
    organizationId: agent.workspace.organizationId,
    provider,
    transport: presence.transport as ChannelTransport,
    appMode: presence.appMode as ChannelAppMode,
    externalId: presence.externalId,
    identity: exchanged.identity,
    credentialsJson: exchanged.credentialsJson,
    actorUserId: presence.createdByUserId,
  });

  // The callback route sends the browser home — to THIS agent's Channels
  // section, resolved from the verified state, never from anything Slack (or
  // the browser) chose.
  return {
    presence: activated,
    agentId: agent.id,
    workspaceId: payload.workspaceId,
  };
};

/**
 * Push a renamed agent's new name onto its live remote apps (the Slack app's
 * display name), so the bot in the customer's workspace tracks the agent.
 * Best-effort per presence and NEVER throws: a rename must not fail because
 * a provider is unreachable or the org never connected a config token —
 * those orgs simply keep the old remote name.
 */
export const syncAgentPresenceNames = async (
  agent: { id: string; organizationId: string },
  name: string,
): Promise<void> => {
  // The whole body sits inside the try — the caller fires this with a bare
  // `void`, so a rejection anywhere (the findMany included) would be an
  // unhandled rejection, not a logged skip.
  try {
    const presences = await db.agentChannel.findMany({
      where: {
        agentId: agent.id,
        status: { in: ["active", "needs_attention"] },
      },
      select: { provider: true, externalId: true },
    });

    for (const presence of presences) {
      const provider = presence.provider as ChannelProviderId;
      const sync = channelProvider(provider).syncRemotePresenceName;
      if (!sync) continue;
      try {
        await withFreshIntegrationCredentials(
          agent.organizationId,
          provider,
          (accessToken) =>
            sync({ accessToken, externalId: presence.externalId, name }),
        );
      } catch (err) {
        log.warn(
          { err, agentId: agent.id, provider, appId: presence.externalId },
          "could not sync the agent's new name onto the remote app; it keeps the old one",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: String(err), agentId: agent.id },
      "agent name sync skipped",
    );
  }
};

/**
 * Detach: snapshot and enqueue the remote teardown, revoke the service key,
 * and delete or shelve the presence, all in ONE transaction, then run the
 * cleanup right away (any failure is retried by maintenance).
 *
 * WITHOUT remote deletion the row stays as a `pending_setup` shell, same
 * externalId, same client credentials, so the next attach resumes THIS app
 * instead of minting a sibling; thread links die with the attachment so a
 * stale link never routes a channel's messages to a detached agent. A
 * remote-deleted app has nothing to reuse: the row goes.
 */
export const detachPresence = async (
  workspaceId: string,
  agentId: string,
  provider: ChannelProviderId,
  options: { deleteRemote: boolean },
): Promise<void> => {
  await requireHostedAgent(workspaceId, agentId);
  const ids = await db.$transaction(async (tx) => {
    await lockChannelLifecycle(tx, workspaceId);
    await lockAgentRow(tx, agentId, workspaceId);
    const presence = await tx.agentChannel.findUnique({
      where: { agentId_provider: { agentId, provider } },
      select: { id: true },
    });
    if (!presence) {
      throw new ServiceError(
        "NOT_FOUND",
        `No ${channelProvider(provider).displayName} app attached`,
      );
    }
    const ids = await enqueueChannelCleanup(
      tx,
      { id: presence.id },
      options.deleteRemote,
    );
    if (options.deleteRemote) {
      await tx.agentChannel.delete({ where: { id: presence.id } });
    } else {
      await tx.agentChannel.update({
        where: { id: presence.id },
        data: { status: "pending_setup", apiKeyId: null },
      });
      await tx.channelThreadLink.deleteMany({
        where: { agentChannelId: presence.id },
      });
    }
    return ids;
  });
  // The agent's instruction doc loses the channel it described.
  rerenderAgentHome(agentId);
  await processChannelCleanups({ ids }).catch(() => undefined);
};

/**
 * The provider REMOVED the presence: the workspace uninstalled the agent's
 * app, or revoked its bot token (Slack: `app_uninstalled`, `tokens_revoked`
 * with a bot entry — the two arrive in either order, so this is idempotent).
 * The presence flips to `disabled` rather than vanishing: the dashboard card
 * stays and says what happened, the agent's instruction doc says its app was
 * removed and drops the messaging tools, and a re-attach resumes THIS app
 * (same id, same client credentials) instead of minting a sibling.
 *
 * Everything a dead presence must not keep doing is torn down here, on the
 * detach precedent: thread links (a stale link must never route a channel's
 * messages to a dead app), the approvals service key (nothing polls on its
 * behalf anymore), and the inbound route's per-app verification cache, which
 * would otherwise keep admitting events for the 60s window. `status` is
 * fenced to the live vocabulary so a presence the owner already detached
 * (`pending_setup`) is left exactly as it was.
 */
export const markPresenceRemoved = async (
  presenceId: string,
  reason: "app_uninstalled" | "tokens_revoked" | "dead_credential",
): Promise<void> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: presenceId },
    select: {
      id: true,
      agentId: true,
      provider: true,
      externalId: true,
      status: true,
      apiKeyId: true,
    },
  });
  if (!presence) return;

  // Not already dead or owner-detached: those rows hold no key and no links
  // (a previous pass, or detach, took them), so there is nothing to tear
  // down and nothing to re-announce.
  if (presence.status !== "active" && presence.status !== "needs_attention") {
    return;
  }

  // The service key goes FIRST and un-swallowed (the detach precedent): the
  // row is about to forget the key id, so a revoke that failed after the
  // write would leave a live key nothing references and no surface can
  // revoke. Throwing here instead lets Slack's webhook retry redo the whole
  // door — the flip below has not happened yet, so the retry finds the row
  // live and takes the same path.
  if (presence.apiKeyId) await revokeServiceApiKey(presence.apiKeyId);

  const { count } = await db.agentChannel.updateMany({
    where: {
      id: presence.id,
      status: { in: ["active", "needs_attention"] },
    },
    data: { status: "disabled", apiKeyId: null },
  });
  // A concurrent pass (Slack's unordered pair landing together) won the
  // flip between our read and our write: its teardown covers ours.
  if (count === 0) return;

  await db.channelThreadLink.deleteMany({
    where: { agentChannelId: presence.id },
  });
  // The column is a free string; a row from a build that knew a provider this
  // one does not has no hook to call (the ingest route's own guard).
  if (isChannelProviderId(presence.provider)) {
    channelProvider(presence.provider).onPresenceRemoved?.({
      externalId: presence.externalId,
    });
  }
  rerenderAgentHome(presence.agentId);
  log.info(
    {
      presenceId: presence.id,
      agentId: presence.agentId,
      provider: presence.provider,
      reason,
    },
    "channel presence removed on the provider side; disabled",
  );
};

/**
 * The OUTBOUND half of removal detection. The uninstall webhooks
 * (`markPresenceRemoved` above) cover the cases Slack tells us about; this
 * covers the ones it cannot: an app DELETED at api.slack.com (the
 * `app_deleted` event is org-admin only, and the revocation webhook may
 * have nowhere to land once the app record is gone), a webhook dropped
 * while the adapter was offline, or an app minted before the manifest
 * subscribed to the removal events. Any outbound call made with the
 * presence's own credential — a reaction, a narration card, a
 * `send_message`, a recipient search — that the provider refuses with a
 * DEAD-credential code (per `isDeadCredentialError`: the codes the provider
 * documents as "this token is for a removed app") flips the presence
 * through the same door, so the card, the doc and the tools tell the same
 * story they would after a webhook. Every other error is left to the
 * caller: a rate limit or a missing scope is not a removal.
 *
 * Returns whether the error WAS a dead credential, so a caller can shape
 * its own message ("your Slack app was removed" beats "invalid_auth").
 * Never throws: the caller's own error is the one that matters, and the
 * flip's failure is logged by `markPresenceRemoved` and retried by the next
 * refused call.
 */
/**
 * The removed-presence fact for the messaging tools: when the agent has NO
 * live presence but a `disabled` one (its app was uninstalled, revoked, or
 * deleted), a tool call must say so, not "nobody matching" or "no presence"
 * (both read as "keep looking" to a model whose tool list still carries the
 * tool). Null when there is nothing removed to explain (no presence at all,
 * or a live one that should simply be used).
 */
export const removedPresenceNotice = async (
  agentId: string,
): Promise<string | null> => {
  const rows = await db.agentChannel.findMany({
    where: {
      agentId,
      status: { in: ["active", "needs_attention", "disabled"] },
    },
    select: { provider: true, status: true },
  });
  if (rows.some((r) => r.status !== "disabled")) return null;
  const removed = rows.filter(
    (r) => r.status === "disabled" && isChannelProviderId(r.provider),
  );
  if (removed.length === 0) return null;
  const names = [
    ...new Set(
      removed.map(
        (r) => channelProvider(r.provider as ChannelProviderId).displayName,
      ),
    ),
  ].join(" and ");
  return `Your ${names} app was removed from the workspace (uninstalled, or its access revoked), so this tool no longer works. It needs to be re-attached from your Channels page in the OneCLI dashboard before you can reach ${names} again. Do not retry.`;
};

export const noteOutboundFailure = async (
  presenceId: string,
  error: unknown,
): Promise<boolean> => {
  if (!isDeadCredentialError(error)) return false;
  try {
    await markPresenceRemoved(presenceId, "dead_credential");
  } catch (flipError) {
    log.warn(
      { presenceId, err: String(flipError) },
      "dead credential detected on an outbound call, but the presence flip failed",
    );
  }
  return true;
};

// Remote create/exchange and activation are one lifecycle operation with
// respect to local teardown. An OAuth code cannot reinstall an app while a
// concurrent delete snapshots its previous token and uninstalls that token.
export const createPresence: typeof createPresenceUnlocked = (...args) =>
  withChannelLifecycle(args[0], () => createPresenceUnlocked(...args));
export const completePresence: typeof completePresenceUnlocked = (...args) =>
  withChannelLifecycle(args[0], () => completePresenceUnlocked(...args));
export const completePresenceFromOAuth = (input: {
  state: string;
  code: string;
  redirectUri: string;
}): ReturnType<typeof completePresenceFromOAuthUnlocked> => {
  // Verified ONCE here: the workspace id keys the lifecycle lock, and the
  // same payload rides into the locked half (never re-parsed from the raw).
  const payload = verifyOAuthState(input.state);
  if (
    !payload ||
    payload.kind !== "channel-install" ||
    typeof payload.workspaceId !== "string"
  ) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const workspaceId = payload.workspaceId;
  return withChannelLifecycle(workspaceId, () =>
    completePresenceFromOAuthUnlocked(input, { ...payload, workspaceId }),
  );
};
