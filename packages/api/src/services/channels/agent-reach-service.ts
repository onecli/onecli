import { db, Prisma } from "@onecli/db";
import { cleanLabel, NO_REPLY_TOKEN } from "@onecli/agent-protocol/text";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  AUDIT_STATUS,
  recordAuditEvent,
} from "../audit-service";
import { lockAgentRow } from "./channel-cleanup-service";
import { channelProvider } from "./registry";
import type { ChannelProviderId, ListenMode } from "./types";
import { logger } from "../../lib/logger";

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
  // A pending ask that aged out (the 14-day sweep) or whose subject failed
  // the approve-time recheck: parked exactly like `left` (hidden, inert),
  // and the next knock/invite re-arms it fresh. Distinct from `left` so
  // the card and dashboard can say what actually happened - the bot did
  // not leave anything.
  "expired",
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

/** The STORED states `isSettled` accepts (legacy spellings included), for a
 * guard that has to run inside the query. */
const SETTLED_STATES = ["approved", "members_only", "denied", "revoked"];

/** What the agent hears in a space (`LISTEN_MODES`); anything unknown reads
 * as the default, `mentions`. */
const normalizeListen = (raw: string | null | undefined): ListenMode =>
  raw === "all" ? "all" : "mentions";

/** One posted owner card - recorded claim-before-post so a retry never
 * double-posts and a decide can rewrite every owner's card. */
export interface CardRef {
  channel: string;
  ts: string;
  userId: string;
}

export const cardRefsOf = (raw: unknown): CardRef[] => {
  if (!Array.isArray(raw)) return [];
  const refs: CardRef[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { channel?: unknown }).channel === "string" &&
      typeof (entry as { ts?: unknown }).ts === "string" &&
      typeof (entry as { userId?: unknown }).userId === "string"
    ) {
      refs.push(entry as unknown as CardRef);
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
 * The waiting line a channel or person hears while its grant is unsettled.
 *
 * Composed here (not in the ingestion door) because only this module knows
 * who the deciders are: it names the workspace owner so the room knows WHO
 * to nudge instead of hearing an ownerless "someone must approve". One
 * short sentence on purpose: the people reading it cannot act on it, and
 * the owner already has the card (and the agent's Contacts page).
 */
export const pendingReachMessage = async (
  workspaceId: string,
): Promise<string> => {
  const owner = await db.workspaceAccess.findFirst({
    where: {
      workspaceId,
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
  });
  const ownerName = owner?.user?.name?.trim();
  return `I can't reply here yet. I've asked ${ownerName || "the workspace owner"} to approve me.`;
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
    select: { id: true, state: true, revision: true },
  });
  if (existing) {
    if (existing.state === "left" || existing.state === "expired") {
      // Re-invite after a leave (or a fresh knock after expiry): re-knock.
      // Atomic on the exact revision so a park/re-arm ABA cannot revive
      // stale context; cardRefs resets to "cards owed".
      const rearmed = await db.agentReachGrant.updateMany({
        where: { id: existing.id, revision: existing.revision },
        data: {
          revision: { increment: 1 },
          state: "pending",
          cardRefs: [],
          decidedByUserId: null,
          decidedAt: null,
          // A re-arm IS a fresh ask (fresh cards, current context), so the
          // ask clock resets with it — otherwise a re-knock after expiry is
          // instantly re-expired by the sweep, and the card's age line
          // would date the new question by the dead one.
          createdAt: new Date(),
          // So is what the agent hears: a fresh approval never silently
          // brings back an old promotion (and skips its intro).
          listen: "mentions",
          ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        },
      });
      if (rearmed.count === 0) {
        const current = await db.agentReachGrant.findUnique({
          where,
          select: { id: true, state: true },
        });
        if (!current) return ensureGrant(input);
        return {
          id: current.id,
          state: normalizeState(current.state),
          created: false,
        };
      }
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
        cardRefs: [],
      },
      select: { id: true, state: true, revision: true },
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
      select: { id: true, state: true, revision: true },
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
export const dmReachableOwners = async (
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
 * in `cardRefs` (claim-before-post is the row's creation with `[]`; this
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
  // ONE poster per grant at a time. The ingest door and the retry sweep can
  // both reach a freshly created grant within milliseconds; each read
  // `cardRefs: []`, each posted, and only the later write survived - so one
  // owner got two identical cards and a decision rewrote only one of them.
  //
  // A TRY lock, held by a transaction that does nothing else: a poster that
  // finds the grant busy skips (whoever holds it posts what is owed, and
  // the sweep re-checks on its next pass), so a stuck Slack call never
  // stacks waiting transactions or pool connections behind it. The refs are
  // written outside that transaction, after each post, so a crash mid-loop
  // can never roll back a card that is already on someone's screen.
  try {
    await db.$transaction(
      async (tx) => {
        const [claim] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`reach-cards:${grantId}`}, 0)) AS locked`;
        if (claim?.locked) await postOwedReachCards(grantId);
      },
      { timeout: REACH_CARD_POST_BUDGET_MS },
    );
  } catch (err) {
    log.warn({ grantId, err: String(err) }, "reach card posting failed");
  }
};

/** How long one grant's posting pass may hold its lock: a post or two per
 * owner, each bounded by the provider's own call timeout. */
const REACH_CARD_POST_BUDGET_MS = 60_000;

const postOwedReachCards = async (grantId: string): Promise<void> => {
  const grant = await db.agentReachGrant.findUnique({
    where: { id: grantId },
    select: {
      id: true,
      revision: true,
      state: true,
      provider: true,
      integrationId: true,
      subjectKind: true,
      subjectLabel: true,
      externalRef: true,
      cardRefs: true,
      createdAt: true,
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

  const posted = cardRefsOf(grant.cardRefs);
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

  // The lateness line: a card posted days after the ask was first raised
  // says so (re-arm retries, an owner linked late). Fresh cards carry
  // nothing — the threshold keeps the common case clean.
  const ageDays = Math.floor(
    (Date.now() - grant.createdAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  const firstAskedDaysAgo = ageDays > 3 ? ageDays : undefined;

  let expectedRevision = grant.revision;
  for (const owner of owed) {
    const current = await db.agentReachGrant.findFirst({
      where: { id: grant.id, revision: expectedRevision, state: "pending" },
      select: { id: true },
    });
    if (!current) return;
    try {
      const ref = await reach.card.post({
        credentialsJson,
        recipientExternalUserId: owner.externalUserId,
        grantId: grant.id,
        subjectKind: grant.subjectKind as ReachSubjectKind,
        agentName: grant.agent.name,
        subjectLabel: grant.subjectLabel ?? grant.externalRef,
        ...(firstAskedDaysAgo !== undefined && { firstAskedDaysAgo }),
      });
      posted.push({ channel: ref.channel, ts: ref.ts, userId: owner.userId });
      // Record after EACH post, not once at the end: a crash mid-loop must
      // not forget a card that is already on someone's screen.
      const recorded = await db.agentReachGrant.updateMany({
        where: { id: grant.id, revision: expectedRevision, state: "pending" },
        // Plain JSON in, structurally: Prisma's InputJsonValue wants no class
        // instances - these are string-field literals already.
        data: {
          cardRefs: posted.map((p) => ({ ...p })),
          revision: { increment: 1 },
        },
      });
      if (recorded.count === 0) return;
      expectedRevision += 1;
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
        { cardRefs: { equals: [] } },
        { cardRefs: { equals: Prisma.DbNull } },
      ],
    },
    select: {
      id: true,
      cardRefs: true,
      agent: { select: { workspaceId: true } },
      integrationId: true,
    },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  for (const grant of pending) {
    const posted = cardRefsOf(grant.cardRefs);
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

/** A pending ask older than this is stale enough to mislead: the asker
 * moved on, the room changed, and an owner approving it acts on dead
 * context. Constant, not config — revisit with evidence, not a knob. */
const REACH_PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Park pending grants that aged past the window — the expiry sweep, called
 * from the adapter's slow loop (the api keeps its no-background-loop law).
 * Parking is `parkReachGrant`'s one body: state → `expired`, cards
 * rewritten so their buttons don't dangle. A fresh knock or invite re-arms
 * (the `ensureGrant` re-knock arm), so nothing is lost — the ask is just
 * re-posed with current context instead of weeks-old context. Idempotent
 * and bounded; returns the count for the caller's log line.
 */
export const expireStaleReachGrants = async (): Promise<{
  expired: number;
}> => {
  const cutoff = new Date(Date.now() - REACH_PENDING_MAX_AGE_MS);
  const stale = await db.agentReachGrant.findMany({
    where: { state: "pending", createdAt: { lt: cutoff } },
    select: {
      id: true,
      revision: true,
      provider: true,
      cardRefs: true,
      subjectLabel: true,
      externalRef: true,
      integrationId: true,
      agent: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let expired = 0;
  for (const grant of stale) {
    const parked = await parkReachGrant({
      grantId: grant.id,
      expectedRevision: grant.revision,
      state: "expired",
      provider: grant.provider as ChannelProviderId,
      agentId: grant.agent.id,
      integrationId: grant.integrationId,
      cardRefs: grant.cardRefs,
      subjectLabel: grant.subjectLabel,
      externalRef: grant.externalRef,
      rewriteCards: true,
    });
    if (parked) expired += 1;
  }
  return { expired };
};

export type ReachDecisionResult =
  | { kind: "decided"; decidedByName: string; state: ReachState }
  | { kind: "already_settled" }
  | { kind: "refused"; message: string };

const decisionAfterRevisionLoss = async (
  grantId: string,
): Promise<ReachDecisionResult> => {
  const current = await db.agentReachGrant.findUnique({
    where: { id: grantId },
    select: { state: true },
  });
  if (!current) {
    return { kind: "refused", message: "This request no longer exists." };
  }
  if (normalizeState(current.state) === "pending") {
    return {
      kind: "refused",
      message: "This request changed while being checked. Please try again.",
    };
  }
  return { kind: "already_settled" };
};

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
      revision: true,
      state: true,
      provider: true,
      integrationId: true,
      subjectKind: true,
      subjectLabel: true,
      externalRef: true,
      cardRefs: true,
      integration: { select: { externalId: true } },
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

  // THE APPROVE-TIME RECHECK (nanoclaw's replay-with-grant lesson): a card
  // may sit for days, and a click that OPENS something must re-verify the
  // subject still exists as asked — a deactivated guest or a channel the
  // bot left must not be recorded as a settlement. Scoped exactly:
  //  - only decisions that open (`approved`/`members_only`); blocking a
  //    ghost is harmless and must never be blocked itself;
  //  - never on `force` — the dashboard override is the management escape
  //    hatch and may flip anything;
  //  - fail-open inside the probe (provider outage ≠ governance outage).
  // A failed recheck parks the grant (`expired`) and rewrites the cards, so
  // the stale ask dies visibly instead of dangling; the next knock or
  // invite re-arms it fresh.
  if (!input.force && input.decision !== "blocked") {
    const reach = channelProvider(grant.provider as ChannelProviderId).reach;
    if (reach) {
      const presence = await db.agentChannel.findFirst({
        where: { agentId: grant.agent.id, integrationId: grant.integrationId },
        select: { credentials: true },
      });
      const credentialsJson = presence?.credentials
        ? await getCrypto().decrypt(presence.credentials)
        : null;
      const verdict = await reach.verifySubject({
        credentialsJson,
        subjectKind: grant.subjectKind as ReachSubjectKind,
        externalRef: grant.externalRef,
        tenantExternalId: grant.integration.externalId,
      });
      if (!verdict.ok) {
        const parked = await parkReachGrant({
          grantId: grant.id,
          expectedRevision: grant.revision,
          state: "expired",
          provider: grant.provider as ChannelProviderId,
          agentId: grant.agent.id,
          integrationId: grant.integrationId,
          cardRefs: grant.cardRefs,
          subjectLabel: grant.subjectLabel,
          externalRef: grant.externalRef,
          rewriteCards: currentState === "pending",
        });
        if (!parked) return decisionAfterRevisionLoss(grant.id);
        return {
          kind: "refused",
          message: `No longer valid - ${verdict.reason}. A new message or invite will ask again.`,
        };
      }
    }
  }

  const decider = await db.user.findUnique({
    where: { id: input.deciderUserId },
    select: { name: true, email: true },
  });
  if (!decider) {
    return { kind: "refused", message: "Unknown decider." };
  }

  // Atomic on the revision we READ: the recheck above is a network call,
  // and even a park/re-arm back to the same state is a different question.
  // A concurrent park or racing decide must not be silently
  // overwritten. Re-read a lost race: a still-pending ask needs an explicit
  // retry refusal, not a settlement response that removes actionable cards.
  // Never retry across revisions: pending may be a newly re-armed question.
  const flipped = await db.agentReachGrant.updateMany({
    where: { id: grant.id, revision: grant.revision },
    data: {
      revision: { increment: 1 },
      state: nextState,
      decidedByUserId: input.deciderUserId,
      decidedAt: new Date(),
      // A channel that now answers no one hears nothing either: promoting
      // it again is a fresh, announced decision.
      ...(!isSettled(nextState) && { listen: "mentions" }),
    },
  });
  if (flipped.count === 0) return decisionAfterRevisionLoss(grant.id);

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
  const refs = cardRefsOf(grant.cardRefs);
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
        const current = await db.agentReachGrant.findFirst({
          where: {
            id: grant.id,
            revision: grant.revision + 1,
            state: nextState,
          },
          select: { id: true },
        });
        if (!current) break;
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
 * Park a grant into a terminal-inert state (`left` = the bot lost the
 * space, `expired` = a pending ask aged out, and the failed approve-time
 * recheck parks too) and rewrite any posted owner cards so their buttons
 * don't dangle. ONE body for every parking cause — the state name is the
 * only difference, and the re-knock arm in `ensureGrant` un-parks both the
 * same way ("the old decision is context, never authority").
 *
 * Card rewrite is best-effort like every settle: the park is durable
 * first, a dead credential just leaves stale cards whose buttons answer
 * already_settled.
 */
export interface ParkReachGrantInput {
  grantId: string;
  /** Revision captured before parking, or the committed revision for settlement. */
  expectedRevision: number;
  state: "left" | "expired";
  provider: ChannelProviderId;
  agentId: string;
  integrationId: string;
  cardRefs: unknown;
  subjectLabel: string | null;
  externalRef: string;
  /** Rewrite cards only when the grant was still pending — a settled
   * grant's cards already show the decision. */
  rewriteCards: boolean;
}

export const parkReachGrant = async (
  input: ParkReachGrantInput,
): Promise<boolean> => {
  const parked = await db.agentReachGrant.updateMany({
    where: {
      id: input.grantId,
      agentId: input.agentId,
      integrationId: input.integrationId,
      revision: input.expectedRevision,
      state: { notIn: ["left", "expired"] },
    },
    data: {
      state: input.state,
      listen: "mentions",
      revision: { increment: 1 },
    },
  });
  if (parked.count === 0) return false;
  await settleParkedReachCards({
    ...input,
    expectedRevision: input.expectedRevision + 1,
  });
  return true;
};

/** Settle captured old cards only after the parking transaction commits.
 * expectedRevision is the committed POST-park revision. Never mutates a grant. */
export const settleParkedReachCards = async (
  input: ParkReachGrantInput,
): Promise<void> => {
  const refs = cardRefsOf(input.cardRefs);
  if (
    input.rewriteCards &&
    refs.length > 0 &&
    isReachCardCapable(input.provider)
  ) {
    const presence = await db.agentChannel.findFirst({
      where: { agentId: input.agentId, integrationId: input.integrationId },
      select: { id: true, credentials: true, updatedAt: true },
    });
    if (presence?.credentials) {
      const credentialsJson = await getCrypto().decrypt(presence.credentials);
      const reach = channelProvider(input.provider).reach;
      for (const ref of refs) {
        const current = await db.agentReachGrant.findFirst({
          where: {
            id: input.grantId,
            agentId: input.agentId,
            integrationId: input.integrationId,
            revision: input.expectedRevision,
            state: input.state,
          },
          select: { id: true },
        });
        const currentPresence = await db.agentChannel.findFirst({
          where: {
            id: presence.id,
            agentId: input.agentId,
            integrationId: input.integrationId,
            credentials: presence.credentials,
            updatedAt: presence.updatedAt,
          },
          select: { id: true },
        });
        if (!current || !currentPresence) return;
        try {
          await reach?.card.settle({
            credentialsJson,
            channel: ref.channel,
            ts: ref.ts,
            subjectLabel: input.subjectLabel ?? input.externalRef,
            outcome: input.state,
            decidedByName: "",
          });
        } catch (err) {
          log.warn(
            { grantId: input.grantId, err: String(err) },
            "park card settle failed",
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
  return db.$transaction(async (tx) => {
    // Same ordering as activation and ingestion: no presence or routing
    // snapshot may outlive a detach/reattach while dismissal is applied.
    await lockAgentRow(tx, input.agentId, input.workspaceId);
    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

    const presence = await tx.agentChannel.findFirst({
      where: { agentId: agent.id, provider: input.provider },
      select: { id: true, integrationId: true },
    });
    if (!presence) {
      throw new ServiceError("NOT_FOUND", "No channel presence for this agent");
    }

    const removed = await tx.agentReachGrant.deleteMany({
      where: {
        agentId: agent.id,
        integrationId: presence.integrationId,
        subjectKind,
        externalRef: input.externalRef,
      },
    });

    // SPACE only: a person's own DM routing must survive their dismissal.
    const reach = channelProvider(input.provider).reach;
    let removedLinks = 0;
    if (reach && subjectKind === "space") {
      const links = await tx.channelThreadLink.findMany({
        where: { agentChannelId: presence.id, kind: "group" },
        select: { id: true, revision: true, externalThreadId: true },
      });
      const doomed = links.filter(
        (link) => reach.spaceOf(link.externalThreadId) === input.externalRef,
      );
      if (doomed.length > 0) {
        const gone = await tx.channelThreadLink.deleteMany({
          where: {
            agentChannelId: presence.id,
            OR: doomed.map(({ id, revision }) => ({ id, revision })),
          },
        });
        removedLinks = gone.count;
      }
    }

    return { removedGrant: removed.count > 0, removedLinks };
  });
};

export interface ReachGrantRow {
  externalRef: string;
  subjectLabel: string | null;
  state: ReachState;
  decidedAt: Date | null;
  /** Space rows: what the agent hears there (person rows: always mentions). */
  listen: ListenMode;
}

/** The dashboard projection: grants of one kind for one agent+provider. */
export const listGrants = async (
  agentId: string,
  provider: ChannelProviderId,
  subjectKind: ReachSubjectKind,
): Promise<ReachGrantRow[]> => {
  const rows = await db.agentReachGrant.findMany({
    // `left` and `expired` rows are parked history (the bot is out of the
    // channel / the ask aged out) - the view hides them; a re-invite or
    // fresh knock re-arms and they reappear as pending. Person rows never
    // reach `left` (there is no channel to leave); the filter covers both.
    where: {
      agentId,
      provider,
      subjectKind,
      state: { notIn: ["left", "expired"] },
    },
    select: {
      externalRef: true,
      subjectLabel: true,
      state: true,
      decidedAt: true,
      listen: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    ...r,
    state: normalizeState(r.state),
    listen: normalizeListen(r.listen),
  }));
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

// ── Listen mode: the channel's "point of contact" ──────────────────────────
// What the agent HEARS in a channel. `mentions` (the default): @mentions and
// threads it already joined, exactly as before. `all`: every message in the
// channel - the agent is the channel's point of contact and decides on its
// own when to answer. Listening never widens WHO is answered: the space
// settlement, the identity lane and person blocks all still apply.

/**
 * Answers one promoted channel may get per rolling hour without an
 * @mention (the judge's picks and calls by name included). Past it the
 * agent hears only @mentions there until the window clears - a busy channel
 * can never become a runaway bill. Mentions are never counted or capped.
 */
export const OVERHEARD_TURNS_PER_HOUR = 120;

/** The space read the overheard door needs: settlement AND listen mode. */
export const resolveSpaceListen = async (input: {
  agentId: string;
  integrationId: string;
  externalRef: string;
}): Promise<{ state: ReachState; listen: ListenMode } | null> => {
  const grant = await db.agentReachGrant.findUnique({
    where: {
      agentId_integrationId_subjectKind_externalRef: {
        agentId: input.agentId,
        integrationId: input.integrationId,
        subjectKind: "space",
        externalRef: input.externalRef,
      },
    },
    select: { state: true, listen: true },
  });
  return grant
    ? {
        state: normalizeState(grant.state),
        listen: normalizeListen(grant.listen),
      }
    : null;
};

/**
 * Promote (or demote) the agent in one channel. Anyone with workspace access
 * to the agent may (the same authority as the channel's answer setting).
 * `all` needs a settlement that answers someone: promoting a channel that is
 * pending or set to "No one" would hear everything and answer nobody.
 * Fenced to the caller's workspace at the query; audited.
 */
export const setSpaceListen = async (input: {
  workspaceId: string;
  agentId: string;
  provider: ChannelProviderId;
  externalRef: string;
  listen: ListenMode;
  userId: string;
  userEmail: string;
}): Promise<{ listen: ListenMode }> => {
  const grant = await db.agentReachGrant.findFirst({
    where: {
      agentId: input.agentId,
      provider: input.provider,
      subjectKind: "space",
      externalRef: input.externalRef,
      agent: { workspaceId: input.workspaceId },
    },
    select: { id: true, state: true, revision: true },
  });
  if (!grant) throw new ServiceError("NOT_FOUND", "Channel not found");
  const promote = input.listen === "all";
  // Atomic on the row we read: two racing promotes flip it once, so the
  // room hears one intro; and a channel settled to "No one" in between is
  // never promoted.
  const flipped = await db.agentReachGrant.updateMany({
    where: {
      id: grant.id,
      revision: grant.revision,
      listen: { not: input.listen },
      ...(promote && { state: { in: SETTLED_STATES } }),
    },
    data: { listen: input.listen, revision: { increment: 1 } },
  });
  if (flipped.count === 0) {
    if (promote && !isSettled(normalizeState(grant.state))) {
      throw new ServiceError(
        "UNPROCESSABLE",
        "Choose who the agent answers in this channel first.",
      );
    }
    return { listen: input.listen };
  }
  await recordAuditEvent({
    workspaceId: input.workspaceId,
    userId: input.userId,
    userEmail: input.userEmail,
    action: AUDIT_ACTIONS.UPDATE,
    service: AUDIT_SERVICES.CHANNEL,
    status: AUDIT_STATUS.SUCCESS,
    source: AUDIT_SOURCE.API,
    metadata: {
      reachGrantId: grant.id,
      agentId: input.agentId,
      externalRef: input.externalRef,
      listen: input.listen,
    },
  });
  // Promotion is announced IN the channel, once per mentions -> all flip:
  // the room should know the agent now reads everything (no silent
  // surveillance). Best-effort and detached - the setting is already saved,
  // and a Slack hiccup must never fail the dashboard click.
  if (promote) {
    void announcePromotion({
      agentId: input.agentId,
      provider: input.provider,
      externalRef: input.externalRef,
    }).catch((err: unknown) =>
      log.warn(
        { err: String(err), agentId: input.agentId },
        "point-of-contact intro post failed",
      ),
    );
  }
  return { listen: input.listen };
};

/** The intro the agent posts when it becomes a channel's point of contact.
 *  Platform-composed: only the agent's own (clamped) name is interpolated. */
const pointOfContactIntro = (agentName: string): string => {
  const name = cleanLabel(agentName) || "I";
  return [
    `:wave: Hi everyone, I'm ${name}. I'm now the point of contact for this channel.`,
    `I read every message here and jump in when I can help, so you don't need to tag me. If you want to be sure I answer, @mention me.`,
  ].join("\n");
};

const announcePromotion = async (input: {
  agentId: string;
  provider: ChannelProviderId;
  externalRef: string;
}): Promise<void> => {
  const presence = await db.agentChannel.findFirst({
    where: {
      agentId: input.agentId,
      provider: input.provider,
      status: "active",
    },
    select: { credentials: true, agent: { select: { name: true } } },
  });
  if (!presence?.credentials) return;
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  await channelProvider(input.provider).sendMessage({
    credentialsJson,
    to: { kind: "channel", ref: input.externalRef },
    text: pointOfContactIntro(presence.agent.name),
  });
};

/**
 * The per-turn note for a conversation that is a PROMOTED channel's room
 * (the agent is its point of contact): tells the model what it is hearing
 * and how to stay silent. Null everywhere else. The channel label is the
 * stored, clamped display label - never raw provider text.
 */
export const buildPointOfContactNote = async (
  conversationId: string,
): Promise<string | null> => {
  const link = await db.channelThreadLink.findUnique({
    where: { conversationId },
    select: {
      kind: true,
      externalThreadId: true,
      agentChannel: {
        select: {
          agentId: true,
          integrationId: true,
          provider: true,
          agent: { select: { name: true } },
        },
      },
    },
  });
  if (!link || link.kind !== "group") return null;
  const reach = channelProvider(
    link.agentChannel.provider as ChannelProviderId,
  ).reach;
  // Only the ROOM conversation (a bare channel address) is the point of
  // contact's; a mention thread in the same channel is an ordinary thread.
  const space = reach?.spaceOf(link.externalThreadId);
  if (!space || space !== link.externalThreadId) return null;
  const grant = await db.agentReachGrant.findUnique({
    where: {
      agentId_integrationId_subjectKind_externalRef: {
        agentId: link.agentChannel.agentId,
        integrationId: link.agentChannel.integrationId,
        subjectKind: "space",
        externalRef: space,
      },
    },
    select: { listen: true, subjectLabel: true },
  });
  if (!grant || normalizeListen(grant.listen) !== "all") return null;
  // The label is provider text (a channel name anyone with rights can set):
  // clamped to one printable line before it enters platform voice, so a
  // crafted name can never open a new line of instructions.
  const where = cleanLabel(grant.subjectLabel ?? "") || "this channel";
  const self = cleanLabel(link.agentChannel.agent.name) || "you";
  return [
    `You are the point of contact in ${where}: you see every message posted there, not only the ones that mention you. Act like the teammate who owns this channel.`,
    `Decide from the CONTEXT of the conversation who each message is for. Answer when: it is addressed to you (your name "${self}" in any language or spelling, an @mention, or a reply in a thread you are part of); or it is a question or request to the whole channel, addressed to no one in particular, that you can genuinely answer or do.`,
    `Never answer a message addressed to someone else (it starts with or names another person, like "Dana, ..." or "Sam, did you ...?"), even if you know the answer: that conversation belongs to them. Also stay silent for greetings, thanks, small talk, jokes, things already handled, and anything you have nothing useful to add to. Never answer a question to the room just to say you don't know or to offer to ask the group (they already did): stay silent. When in doubt, stay silent.`,
    `To stay silent, answer with exactly \`${NO_REPLY_TOKEN}\` and nothing else: nothing is posted in the channel. When you do reply, the platform posts it where it fits: in the channel, or in a thread under the message. It reads the channel to decide (how people here reply, the length of the answer), and if someone asks you to reply in threads or in the channel, it follows that from the next message on. You do not choose this yourself, so never apologize for where a reply landed or promise to change it. When someone asks for threads or the channel, just acknowledge it like a teammate would ("Sure 👍"). If asked why, explain it in one short line. Reply in the language the person wrote in.`,
    `You can still act: message a person, a channel, or another agent when that is the right move (the usual approvals apply). An approval card is never posted in this channel: it goes privately to the person who approves your actions, in their direct messages with you. When an action needs one, say so in plain words ("I've sent the approval to your DMs with me"), never "you should get a card here".`,
  ].join("\n");
};
