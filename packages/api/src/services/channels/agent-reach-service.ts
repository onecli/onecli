import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  AUDIT_STATUS,
  recordAuditEvent,
} from "../audit-service";
import { channelProvider } from "./registry";
import type { ChannelProviderId } from "./types";
import { logger } from "../../lib/logger";
import { dashboardUrl } from "../../lib/dashboard-url";

const log = logger.child({ component: "agent-reach" });

/**
 * The agent's REACH ledger (who may talk to it) - the service face of
 * `AgentReachGrant`. Reach is a separate axis from workspace access:
 * the identity lane (`authorizeSpeaker`) always runs FIRST and is never
 * narrowed by anything here - a grant can only widen who is answered.
 *
 * v1 ships SPACE grants ("may the agent answer everyone in this channel"),
 * created pending on invite (and lazily on the first refused stranger),
 * decided from the owner-DM card or the dashboard. `external_user` rows
 * (the person knock) are the designed follow-up on this same table, with
 * the precedence law reserved: a person-level denied beats a space-level
 * approved.
 *
 * The owner-DM card is PLATFORM-composed and rides the presence's own bot
 * token - the agent's model never sees a grant request, and the bot-authored
 * card can never loop back in (the ingestion echo guard drops it).
 */

export const REACH_SUBJECT_KINDS = ["space", "external_user"] as const;
export type ReachSubjectKind = (typeof REACH_SUBJECT_KINDS)[number];

export const REACH_STATES = [
  // Not settled yet: the agent answers NOBODY in this channel and says so
  // (the owner card is out). Every channel starts here - the settlement is
  // a precondition, not a fallback for strangers.
  "pending",
  // "Allow anyone here": everyone in the channel (same provider tenant).
  "approved",
  // "OneCLI users only": the identity lane alone - today's historical
  // default, now an explicit decision.
  "members_only",
  // "Don't allow": the agent stays silent in this channel entirely.
  "blocked",
  // Legacy decisions, read-compatible: both meant "identity lane only",
  // which is exactly `members_only`. Normalized on read (normalizeState)
  // so no backfill is needed and old rows keep behaving.
  "denied",
  "revoked",
  // The bot was removed from the channel: the row is parked (hidden from
  // the view, inert in the guest lane) with its decision history kept. A
  // re-invite re-knocks - the room's population may have changed since the
  // original approval, so the old decision is context, never authority.
  "left",
] as const;
export type ReachState = (typeof REACH_STATES)[number];

/** The states a channel can be SETTLED into by a human decision. */
export const REACH_DECISIONS = ["approved", "members_only", "blocked"] as const;
export type ReachDecision = (typeof REACH_DECISIONS)[number];

/**
 * Read-normalization for the legacy vocabulary: `denied` and `revoked` both
 * meant "identity lane only", which is `members_only` in the settled model.
 * Applied at every read so old rows behave and no backfill is needed.
 */
export const normalizeState = (raw: string): ReachState =>
  raw === "denied" || raw === "revoked" ? "members_only" : (raw as ReachState);

/** Does this settlement let the agent speak to anyone at all here? */
export const isSettled = (state: ReachState): boolean =>
  state === "approved" || state === "members_only";

/** One posted owner card - recorded claim-before-post so a retry never
 * double-posts and a decide can rewrite every owner's card. */
export interface ReachPromptRef {
  channel: string;
  ts: string;
  userId: string;
}

const promptRefsOf = (raw: unknown): ReachPromptRef[] => {
  if (!Array.isArray(raw)) return [];
  const refs: ReachPromptRef[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { channel?: unknown }).channel === "string" &&
      typeof (entry as { ts?: unknown }).ts === "string" &&
      typeof (entry as { userId?: unknown }).userId === "string"
    ) {
      refs.push(entry as unknown as ReachPromptRef);
    }
  }
  return refs;
};

/**
 * Is this space open to everyone (same provider tenant)? The ingestion
 * door's fallback lane - one indexed read; state alone decides.
 */
export const resolveReach = async (input: {
  agentId: string;
  integrationId: string;
  subjectKind: ReachSubjectKind;
  externalRef: string;
}): Promise<ReachState | null> => {
  const grant = await db.agentReachGrant.findUnique({
    where: {
      agentId_integrationId_subjectKind_externalRef: {
        agentId: input.agentId,
        integrationId: input.integrationId,
        subjectKind: input.subjectKind,
        externalRef: input.externalRef,
      },
    },
    select: { state: true },
  });
  return grant ? normalizeState(grant.state) : null;
};

/** The space-shaped read (a channel's settlement). */
export const resolveSpaceReach = (input: {
  agentId: string;
  integrationId: string;
  externalRef: string;
}): Promise<ReachState | null> =>
  resolveReach({ ...input, subjectKind: "space" });

/**
 * The person-shaped read (one provider user's standing with this agent).
 *
 * Its own name rather than a bare `subjectKind` argument at the call sites,
 * because the two kinds answer different questions and mixing them up is
 * exactly the bug this ledger's precedence law exists to prevent.
 */
export const resolvePersonReach = (input: {
  agentId: string;
  integrationId: string;
  externalRef: string;
}): Promise<ReachState | null> =>
  resolveReach({ ...input, subjectKind: "external_user" });

/**
 * The waiting line a channel hears while its grant is unsettled.
 *
 * Composed here (not in the ingestion door) because only this module knows
 * who the deciders are: it names the workspace owner so the room knows WHO
 * to nudge instead of hearing an ownerless "someone must approve", and
 * carries the ready dashboard link so that person can settle it without
 * hunting. Both parts degrade gracefully - an unnamed owner or an
 * unconfigured origin just drops that clause rather than failing the turn.
 */
export const pendingReachMessage = async (input: {
  agentId: string;
  workspaceId: string;
}): Promise<string> => {
  const [owner, agent] = await Promise.all([
    db.workspaceAccess.findFirst({
      where: {
        workspaceId: input.workspaceId,
        role: "owner",
        userId: { not: null },
      },
      // NAME ONLY, never the email. This sentence is posted into a channel
      // that by definition may contain people outside the workspace (that
      // is the whole question being asked), so the owner's email address
      // must not ride along - an unnamed owner degrades to the generic
      // phrase instead of escalating to a contact detail.
      select: { user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.agent.findUnique({
      where: { id: input.agentId },
      select: { name: true },
    }),
  ]);
  const ownerName = owner?.user?.name?.trim();
  const who = ownerName
    ? `${ownerName} (this workspace's owner)`
    : "the workspace owner";
  const link = dashboardUrl(`/agents/${input.agentId}/channels`, {
    workspaceId: input.workspaceId,
  });
  const me = agent?.name?.trim() || "this agent";
  return (
    `I can't answer here yet - ${who} needs to approve me for this channel first.` +
    ` I've sent them the request.\n` +
    `They can decide here: ${link}` +
    ` (choose whether ${me} answers everyone in this channel, only OneCLI` +
    ` teammates, or no one).`
  );
};

/**
 * Get-or-create the pending space grant - the invite hook and the lazy
 * re-offer both land here, so a channel only ever asks once. Idempotent:
 * an existing row in ANY live state is returned untouched (a denied channel
 * must not re-knock on every stranger message). The ONE exception: a `left`
 * row - the bot was removed and is now back (a re-invite, or the dashboard
 * acting on it); the row re-arms to `pending` and the cards go out fresh.
 */
export const ensureGrant = async (input: {
  agentId: string;
  integrationId: string;
  provider: ChannelProviderId;
  subjectKind: ReachSubjectKind;
  externalRef: string;
  subjectLabel?: string | null;
}): Promise<{ id: string; state: ReachState; created: boolean }> => {
  const where = {
    agentId_integrationId_subjectKind_externalRef: {
      agentId: input.agentId,
      integrationId: input.integrationId,
      subjectKind: input.subjectKind,
      externalRef: input.externalRef,
    },
  };
  const existing = await db.agentReachGrant.findUnique({
    where,
    select: { id: true, state: true },
  });
  if (existing) {
    if (existing.state === "left") {
      // Re-invite after a leave: re-knock. Atomic on the state so two
      // concurrent doors re-arm once; promptRefs resets to "cards owed".
      const rearmed = await db.agentReachGrant.updateMany({
        where: { id: existing.id, state: "left" },
        data: {
          state: "pending",
          promptRefs: [],
          decidedByUserId: null,
          decidedAt: null,
          ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        },
      });
      return {
        id: existing.id,
        state: "pending",
        // Re-armed counts as created for the caller's "post the cards" cue;
        // a lost race means someone else re-armed - they own the cards.
        created: rearmed.count > 0,
      };
    }
    return {
      id: existing.id,
      state: normalizeState(existing.state),
      created: false,
    };
  }
  try {
    const created = await db.agentReachGrant.create({
      data: {
        agentId: input.agentId,
        integrationId: input.integrationId,
        provider: input.provider,
        subjectKind: input.subjectKind,
        externalRef: input.externalRef,
        subjectLabel: input.subjectLabel ?? null,
        // Claimed-but-unposted: the card poster (below) and its sweep read
        // the empty array as "cards still owed".
        promptRefs: [],
      },
      select: { id: true, state: true },
    });
    return {
      id: created.id,
      state: normalizeState(created.state),
      created: true,
    };
  } catch (err) {
    // Lost the race - re-read what won.
    const winner = await db.agentReachGrant.findUnique({
      where,
      select: { id: true, state: true },
    });
    if (winner) {
      return {
        id: winner.id,
        state: normalizeState(winner.state),
        created: false,
      };
    }
    throw err;
  }
};

/** Get-or-create a SPACE grant (a channel's settlement). */
export const ensureSpaceGrant = (input: {
  agentId: string;
  integrationId: string;
  provider: ChannelProviderId;
  externalRef: string;
  subjectLabel?: string | null;
}): Promise<{ id: string; state: ReachState; created: boolean }> =>
  ensureGrant({ ...input, subjectKind: "space" });

/**
 * Get-or-create a PERSON grant - the DM knock.
 *
 * `externalRef` is the provider's own user id (Slack: `U…`), which is stable
 * across renames; `subjectLabel` is the display name captured for the card
 * and the dashboard, and is never used for matching.
 */
export const ensurePersonGrant = (input: {
  agentId: string;
  integrationId: string;
  provider: ChannelProviderId;
  externalRef: string;
  subjectLabel?: string | null;
}): Promise<{ id: string; state: ReachState; created: boolean }> =>
  ensureGrant({ ...input, subjectKind: "external_user" });

/**
 * The notify targets: workspace-access OWNER-role holders (the user's
 * decision: the owner is who controls the workspace - createdByUserId stays
 * provenance) who hold a ChannelUserLink on this integration, i.e. are
 * DM-reachable. Empty = dashboard-only pending, which is the durable
 * surface anyway.
 */
const dmReachableOwners = async (
  workspaceId: string,
  integrationId: string,
): Promise<{ userId: string; externalUserId: string }[]> => {
  const owners = await db.workspaceAccess.findMany({
    where: { workspaceId, role: "owner", userId: { not: null } },
    select: { userId: true },
  });
  const ownerIds = owners
    .map((o) => o.userId)
    .filter((id): id is string => id !== null);
  if (ownerIds.length === 0) return [];
  const links = await db.channelUserLink.findMany({
    where: { integrationId, userId: { in: ownerIds } },
    select: { userId: true, externalUserId: true },
  });
  return links;
};

/**
 * Post the owner-DM cards for one pending grant, recording each posted card
 * in `promptRefs` (claim-before-post is the row's creation with `[]`; this
 * is the post-and-record half). Card composition and delivery are the
 * provider's business - the service passes only opaque strings and the
 * grant id (the button value; the injection rule: nothing else rides the
 * payload).
 *
 * Failure-tolerant by contract: a card that cannot post is skipped (logged)
 * and stays owed - `sweepUnpostedReachCards` retries on the adapter's work
 * cadence. Never throws into the ingest path.
 */
export const postReachCards = async (grantId: string): Promise<void> => {
  const grant = await db.agentReachGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      state: true,
      provider: true,
      integrationId: true,
      subjectKind: true,
      subjectLabel: true,
      externalRef: true,
      promptRefs: true,
      agent: {
        select: { id: true, name: true, workspaceId: true },
      },
    },
  });
  if (!grant || grant.state !== "pending") return;
  const provider = grant.provider;
  if (!isReachCardCapable(provider)) return;

  const presence = await db.agentChannel.findFirst({
    where: { agentId: grant.agent.id, integrationId: grant.integrationId },
    select: { credentials: true },
  });
  if (!presence?.credentials) return;

  const posted = promptRefsOf(grant.promptRefs);
  const alreadyNotified = new Set(posted.map((p) => p.userId));

  const owners = await dmReachableOwners(
    grant.agent.workspaceId,
    grant.integrationId,
  );
  const owed = owners.filter((o) => !alreadyNotified.has(o.userId));
  if (owed.length === 0) return;

  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  const reach = channelProvider(provider as ChannelProviderId).reach;
  if (!reach) return;

  for (const owner of owed) {
    try {
      const ref = await reach.card.post({
        credentialsJson,
        recipientExternalUserId: owner.externalUserId,
        grantId: grant.id,
        subjectKind: grant.subjectKind as ReachSubjectKind,
        agentName: grant.agent.name,
        subjectLabel: grant.subjectLabel ?? grant.externalRef,
      });
      posted.push({ channel: ref.channel, ts: ref.ts, userId: owner.userId });
      // Record after EACH post, not once at the end: a crash mid-loop must
      // not forget a card that is already on someone's screen.
      await db.agentReachGrant.update({
        where: { id: grant.id },
        // Plain JSON in, structurally: Prisma's InputJsonValue wants no class
        // instances - these are string-field literals already.
        data: { promptRefs: posted.map((p) => ({ ...p })) },
      });
    } catch (err) {
      log.warn(
        { grantId: grant.id, err: String(err) },
        "reach card post failed; the sweep retries",
      );
    }
  }
};

/** Providers that can carry the owner-DM card (the reach facet exists). */
const isReachCardCapable = (provider: string): boolean => {
  try {
    return Boolean(channelProvider(provider as ChannelProviderId).reach);
  } catch {
    return false;
  }
};

/**
 * The retry arm: pending grants of EVERY kind whose owner cards are still
 * owed. Called from the adapter work poll's cadence (bounded), so a failed
 * post (Slack down, credential mid-rotation) self-heals without a dedicated
 * scheduler. Kind-agnostic on purpose: a person knock whose card never
 * posted is exactly as stuck as a space one, and the poster already routes
 * by the row's own `subjectKind`.
 */
export const sweepUnpostedReachCards = async (): Promise<void> => {
  const pending = await db.agentReachGrant.findMany({
    where: {
      state: "pending",
      // Only rows that still OWE a card. A pending grant whose owners were
      // all notified is waiting on a human and may sit for weeks - without
      // this it still occupied one of the `take` slots, and five such rows
      // starved every newer knock forever (oldest-first ordering). The
      // cheap half of the filter runs in SQL (`[]` = claimed, never
      // posted); the exact per-owner check stays below, because "which
      // owners are DM-reachable" is a join this query cannot express.
      //
      // `equals: []` matches the claim-before-post sentinel; the DB-null
      // arm (Prisma's own sentinel, not a bare null) keeps legacy rows
      // sweepable rather than silently stranding them.
      OR: [
        { promptRefs: { equals: [] } },
        { promptRefs: { equals: Prisma.DbNull } },
      ],
    },
    select: {
      id: true,
      promptRefs: true,
      agent: { select: { workspaceId: true } },
      integrationId: true,
    },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  for (const grant of pending) {
    const posted = promptRefsOf(grant.promptRefs);
    const owners = await dmReachableOwners(
      grant.agent.workspaceId,
      grant.integrationId,
    );
    const notified = new Set(posted.map((p) => p.userId));
    if (owners.some((o) => !notified.has(o.userId))) {
      await postReachCards(grant.id);
    }
  }
};

export type ReachDecisionResult =
  | { kind: "decided"; decidedByName: string; state: ReachState }
  | { kind: "already_settled" }
  | { kind: "refused"; message: string };

/**
 * The ONE decide door - the DM card click (via the channel-authorized
 * clicker) and the dashboard PUT (via the session-authorized caller) both
 * land here with a RESOLVED platform user the caller already fenced
 * (workspace access - deciding is governance). Flips state, stamps the
 * decider, audits, and rewrites every posted owner card.
 */
export const decideReachGrant = async (input: {
  grantId: string;
  /** The settlement chosen: open to the channel, identity lane only, or
   * silent here. Three options because a channel's question has three
   * honest answers - "not everyone" is not the same as "not at all". */
  decision: ReachDecision;
  deciderUserId: string;
  /** The DASHBOARD door's explicit management override: it may flip any
   * settled state (re-open a denied channel, re-close an approved one).
   * Card clicks leave this unset - a second click on a settled card must
   * answer already_settled, never re-flip. */
  force?: boolean;
}): Promise<ReachDecisionResult> => {
  const grant = await db.agentReachGrant.findUnique({
    where: { id: input.grantId },
    select: {
      id: true,
      state: true,
      provider: true,
      integrationId: true,
      subjectKind: true,
      subjectLabel: true,
      externalRef: true,
      promptRefs: true,
      agent: { select: { id: true, workspaceId: true } },
    },
  });
  if (!grant) {
    return { kind: "refused", message: "This request no longer exists." };
  }

  const nextState: ReachState = input.decision;
  const currentState = normalizeState(grant.state);

  // Idempotent on the same outcome; a real decision beats a pending row
  // only once (two owners racing: first click wins, the second reads
  // already_settled and their card is rewritten by the first's pass).
  // The dashboard door (`force`) may flip any state - it is an explicit
  // management action, not a stale card.
  if (currentState === nextState) return { kind: "already_settled" };
  if (!input.force && currentState !== "pending") {
    return { kind: "already_settled" };
  }

  const decider = await db.user.findUnique({
    where: { id: input.deciderUserId },
    select: { name: true, email: true },
  });
  if (!decider) {
    return { kind: "refused", message: "Unknown decider." };
  }

  await db.agentReachGrant.update({
    where: { id: grant.id },
    data: {
      state: nextState,
      decidedByUserId: input.deciderUserId,
      decidedAt: new Date(),
    },
  });

  await recordAuditEvent({
    workspaceId: grant.agent.workspaceId,
    userId: input.deciderUserId,
    userEmail: decider.email,
    action:
      input.decision === "approved"
        ? AUDIT_ACTIONS.APPROVE
        : AUDIT_ACTIONS.DENY,
    service: AUDIT_SERVICES.CHANNEL,
    status: AUDIT_STATUS.SUCCESS,
    source: AUDIT_SOURCE.API,
    metadata: {
      reachGrantId: grant.id,
      agentId: grant.agent.id,
      subjectKind: grant.subjectKind,
      externalRef: grant.externalRef,
      decision: input.decision,
    },
  });

  // Rewrite every posted owner card - best-effort, the decision is already
  // durable. The provider owns rendering; a dead credential just leaves
  // stale cards whose buttons answer already_settled.
  const refs = promptRefsOf(grant.promptRefs);
  if (refs.length > 0 && isReachCardCapable(grant.provider)) {
    const presence = await db.agentChannel.findFirst({
      where: { agentId: grant.agent.id, integrationId: grant.integrationId },
      select: { credentials: true },
    });
    if (presence?.credentials) {
      const credentialsJson = await getCrypto().decrypt(presence.credentials);
      const reach = channelProvider(grant.provider as ChannelProviderId).reach;
      const decidedByName = decider.name || decider.email;
      for (const ref of refs) {
        try {
          await reach?.card.settle({
            credentialsJson,
            channel: ref.channel,
            ts: ref.ts,
            subjectLabel: grant.subjectLabel ?? grant.externalRef,
            subjectKind: grant.subjectKind as ReachSubjectKind,
            outcome: nextState,
            decidedByName,
          });
        } catch (err) {
          log.warn(
            { grantId: grant.id, err: String(err) },
            "reach card rewrite failed",
          );
        }
      }
    }
  }

  return {
    kind: "decided",
    decidedByName: decider.name || decider.email,
    state: nextState,
  };
};

/**
 * The dashboard door: upsert-and-set for a named space - the Channels
 * section's per-channel toggle. The caller (route) already fenced workspace
 * access; agent/workspace coherence is fenced HERE (the id pair must hold).
 */
export const setReachState = async (input: {
  workspaceId: string;
  agentId: string;
  provider: ChannelProviderId;
  subjectKind: ReachSubjectKind;
  externalRef: string;
  state: ReachDecision;
  deciderUserId: string;
}): Promise<ReachDecisionResult> => {
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, provider: input.provider },
    select: { integrationId: true },
  });
  if (!presence) {
    throw new ServiceError("NOT_FOUND", "No channel presence for this agent");
  }

  const grant = await ensureGrant({
    agentId: input.agentId,
    integrationId: presence.integrationId,
    provider: input.provider,
    subjectKind: input.subjectKind,
    externalRef: input.externalRef,
  });

  return decideReachGrant({
    grantId: grant.id,
    decision: input.state,
    deciderUserId: input.deciderUserId,
    force: true,
  });
};

/**
 * The card click's decide door - mirrors `decideApprovalFromChannel`: the
 * CLICKER is resolved and authorized as a workspace-access holder before
 * anything flips (deciding is governance; the card being in someone's DM is
 * not authority). Serves BOTH transports: the HTTP interactivity route and
 * the socket adapter's forwarded click.
 */
export const decideReachFromChannel = async (input: {
  presenceId: string;
  grantId: string;
  decision: ReachDecision;
  clickerExternalUserId: string;
}): Promise<ReachDecisionResult> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: input.presenceId },
    select: {
      integrationId: true,
      provider: true,
      credentials: true,
      agent: {
        select: {
          id: true,
          workspaceId: true,
          workspace: { select: { id: true, organizationId: true } },
        },
      },
    },
  });
  if (!presence) {
    return { kind: "refused", message: "This agent is no longer attached." };
  }

  // Resolve the clicker exactly like the approval decide: existing link,
  // else the provider's verified-email lookup feeding the lazy link.
  let email: string | undefined;
  const existingLink = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId: input.clickerExternalUserId,
      },
    },
    select: { id: true },
  });
  if (!existingLink) {
    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    email = await channelProvider(
      presence.provider as ChannelProviderId,
    ).lookupUserEmail({
      credentialsJson,
      externalUserId: input.clickerExternalUserId,
    });
  }

  // Dynamic in THIS direction on purpose: the ingestion service dynamically
  // imports this module (its guest lane), so the static edge must not point
  // back at it - the pair would cycle.
  const { authorizeChannelUser } = await import("./channel-ingestion-service");
  const clicker = await authorizeChannelUser(
    presence.integrationId,
    presence.agent.workspace.organizationId,
    presence.agent.workspace,
    input.clickerExternalUserId,
    email,
  );
  if (!clicker) {
    return {
      kind: "refused",
      message:
        "Only workspace members can decide this. Ask an admin for access, or decide it from the dashboard.",
    };
  }

  return decideReachFromChannelWithUser({
    presenceId: input.presenceId,
    grantId: input.grantId,
    decision: input.decision,
    clickerUserId: clicker.userId,
  });
};

/**
 * The card click's decide door - mirrors `decideApprovalFromChannel` - with
 * the clicker ALREADY resolved to a platform user by the caller: the route
 * runs `authorizeChannelUser` exactly like the approval decide (deciding is
 * governance; the card being in someone's DM is not authority). The grant
 * must belong to THIS presence's agent+integration - a forged grant id from
 * another tenant gets a not-found-shaped refusal, hint-free.
 */
export const decideReachFromChannelWithUser = async (input: {
  presenceId: string;
  grantId: string;
  decision: ReachDecision;
  clickerUserId: string;
}): Promise<ReachDecisionResult> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: input.presenceId },
    select: {
      integrationId: true,
      agent: { select: { id: true } },
    },
  });
  if (!presence) {
    return { kind: "refused", message: "This agent is no longer attached." };
  }
  const grant = await db.agentReachGrant.findUnique({
    where: { id: input.grantId },
    select: { agentId: true, integrationId: true },
  });
  if (
    !grant ||
    grant.agentId !== presence.agent.id ||
    grant.integrationId !== presence.integrationId
  ) {
    return { kind: "refused", message: "This request no longer exists." };
  }
  return decideReachGrant({
    grantId: input.grantId,
    decision: input.decision,
    deciderUserId: input.clickerUserId,
  });
};

/**
 * The leave hook (ingestGroupLeave): park the channel's grant as `left` -
 * hidden from the view, inert in the guest lane, decision history kept -
 * and settle any open owner cards so a pending question about a channel
 * the agent just left does not dangle as a live-looking card.
 */
export const parkGrantOnLeave = async (input: {
  agentId: string;
  integrationId: string;
  provider: ChannelProviderId;
  externalRef: string;
}): Promise<void> => {
  const grant = await db.agentReachGrant.findUnique({
    where: {
      agentId_integrationId_subjectKind_externalRef: {
        agentId: input.agentId,
        integrationId: input.integrationId,
        subjectKind: "space",
        externalRef: input.externalRef,
      },
    },
    select: {
      id: true,
      state: true,
      promptRefs: true,
      subjectLabel: true,
      externalRef: true,
    },
  });
  if (!grant || grant.state === "left") return;

  const wasPending = grant.state === "pending";
  await db.agentReachGrant.update({
    where: { id: grant.id },
    data: { state: "left" },
  });

  // A pending grant's owner cards are now moot - rewrite them so the
  // buttons don't dangle (a click would answer already_settled anyway;
  // this is about honesty, not safety). Best-effort, like every settle.
  const refs = promptRefsOf(grant.promptRefs);
  if (wasPending && refs.length > 0 && isReachCardCapable(input.provider)) {
    const presence = await db.agentChannel.findFirst({
      where: { agentId: input.agentId, integrationId: input.integrationId },
      select: { credentials: true },
    });
    if (presence?.credentials) {
      const credentialsJson = await getCrypto().decrypt(presence.credentials);
      const reach = channelProvider(input.provider).reach;
      for (const ref of refs) {
        try {
          await reach?.card.settle({
            credentialsJson,
            channel: ref.channel,
            ts: ref.ts,
            subjectLabel: grant.subjectLabel ?? grant.externalRef,
            outcome: "left",
            decidedByName: "",
          });
        } catch (err) {
          log.warn(
            { grantId: grant.id, err: String(err) },
            "leave card settle failed",
          );
        }
      }
    }
  }
};

/** The dashboard's per-SPACE settlement. */
export const setSpaceReachState = (input: {
  workspaceId: string;
  agentId: string;
  provider: ChannelProviderId;
  externalRef: string;
  state: ReachDecision;
  deciderUserId: string;
}): Promise<ReachDecisionResult> =>
  setReachState({ ...input, subjectKind: "space" });

/**
 * The dashboard's per-PERSON settlement. `members_only` is refused rather
 * than silently stored: it is not a coherent answer about one individual,
 * and letting it through would put a state on the row that the person card
 * can never render.
 */
export const setPersonReachState = (input: {
  workspaceId: string;
  agentId: string;
  provider: ChannelProviderId;
  externalRef: string;
  state: Extract<ReachDecision, "approved" | "blocked">;
  deciderUserId: string;
}): Promise<ReachDecisionResult> =>
  setReachState({ ...input, subjectKind: "external_user" });

/**
 * The dashboard's DISMISS: forget this subject entirely - delete the grant
 * row (whatever its state; the user's decision: dismiss always available)
 * and, for a SPACE, the channel's thread links. The next message from that
 * subject re-knocks fresh (the lazy re-offer), and a re-mention re-creates
 * the routing links and resumes the same conversations. Distinct from
 * revoke on purpose: revoke is a sticky no; dismiss is "as if never asked".
 *
 * The link sweep is space-only by construction: a person's DM thread link
 * belongs to whoever the DM is WITH, and for a guest there is no link to
 * this subject at all (their turns live in a sourced conversation keyed by
 * the DM address). Deleting links on a person dismiss would cut a linked
 * teammate's own DM routing - a different person's data.
 */
export const dismissReachRow = async (input: {
  workspaceId: string;
  agentId: string;
  provider: ChannelProviderId;
  subjectKind?: ReachSubjectKind;
  externalRef: string;
  dismissedByUserId: string;
}): Promise<{ removedGrant: boolean; removedLinks: number }> => {
  const subjectKind = input.subjectKind ?? "space";
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, provider: input.provider },
    select: { id: true, integrationId: true },
  });
  if (!presence) {
    throw new ServiceError("NOT_FOUND", "No channel presence for this agent");
  }

  const removed = await db.agentReachGrant.deleteMany({
    where: {
      agentId: input.agentId,
      integrationId: presence.integrationId,
      subjectKind,
      externalRef: input.externalRef,
    },
  });

  // The channel's thread links go too - "forget" includes the routing rows.
  // Provider-keyed matching, same as the leave door. SPACE only (see above).
  const reach = channelProvider(input.provider).reach;
  let removedLinks = 0;
  if (reach && subjectKind === "space") {
    const links = await db.channelThreadLink.findMany({
      where: { agentChannelId: presence.id, kind: "group" },
      select: { id: true, externalThreadId: true },
    });
    const doomed = links
      .filter((l) => reach.spaceOf(l.externalThreadId) === input.externalRef)
      .map((l) => l.id);
    if (doomed.length > 0) {
      const gone = await db.channelThreadLink.deleteMany({
        where: { id: { in: doomed } },
      });
      removedLinks = gone.count;
    }
  }

  return { removedGrant: removed.count > 0, removedLinks };
};

export interface ReachGrantRow {
  externalRef: string;
  subjectLabel: string | null;
  state: ReachState;
  decidedAt: Date | null;
}

/** The dashboard projection: grants of one kind for one agent+provider. */
export const listGrants = async (
  agentId: string,
  provider: ChannelProviderId,
  subjectKind: ReachSubjectKind,
): Promise<ReachGrantRow[]> => {
  const rows = await db.agentReachGrant.findMany({
    // `left` rows are parked history (the bot is out of the channel) - the
    // view hides them; a re-invite re-arms and they reappear as pending.
    // Person rows never reach `left` (there is no channel to leave), so the
    // filter is simply inert for them.
    where: { agentId, provider, subjectKind, state: { not: "left" } },
    select: {
      externalRef: true,
      subjectLabel: true,
      state: true,
      decidedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ ...r, state: normalizeState(r.state) }));
};

/** Every SPACE grant (the Channels section). */
export const listSpaceGrants = (
  agentId: string,
  provider: ChannelProviderId,
): Promise<ReachGrantRow[]> => listGrants(agentId, provider, "space");

/** Every PERSON grant (the People section). */
export const listPersonGrants = (
  agentId: string,
  provider: ChannelProviderId,
): Promise<ReachGrantRow[]> => listGrants(agentId, provider, "external_user");
