import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../errors";
import { decryptCached } from "./channel-decrypt-cache";
import {
  CHANNEL_ADAPTER_TOKEN,
  RUNNER_ONLINE_THRESHOLD_SECONDS,
} from "../../lib/env";
import type { ChannelProviderId, ChannelTransport } from "./types";
import { publicApiUrl } from "./posture";
import { sweepStaleSessionReceipts } from "./turn-receipt-service";
import { agentImageUrlOrNull } from "../agent-image-service";

/**
 * The channel adapter's control-plane service: registration and liveness
 * (the `RUNNER_TOKEN` anchor pattern, plus per-instance minting), the config
 * feed that tells the adapter what to hold open, and the batched work poll
 * that drives the completion pass (answers and mirrors, posted once per turn).
 *
 * The §3.17 sharding seam lives HERE, exactly as this module always promised:
 * a presence-ownership claim (the `due-work.ts` pattern) partitions the fleet
 * across adapter instances without touching the adapter's wire contract —
 * each instance's config/work/prompt feeds serve only the presences it holds
 * a live lease on. One instance therefore claims everything (the self-host
 * singleton, unchanged behavior); N instances divide the fleet and a dead
 * instance's slice fails over when its leases lapse.
 *
 * ⚠️ Every ownership write is RAW SQL on purpose: a Prisma update would bump
 * `updated_at`, which is a config-etag input, and a lease renewal that busts
 * the etag every poll would recreate the KMS decrypt storm the ownership
 * split exists to kill (the etag-stability test pins this).
 */

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export type RegisterAdapterResult =
  | { ok: true; adapterId: string; mintedToken?: string }
  | { ok: false };

/** Instance rows this stale are reaped opportunistically at register — far
 * beyond every lease/online window (45s/90s), so only a truly dead twin ever
 * matches. Anchor rows are never reaped: an idle self-host that comes back
 * after a month must not have lost its identity. */
const ADAPTER_REAP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Register (or re-register) an adapter.
 *
 * Legacy arm (no `perInstance` — old binaries): the runner law verbatim. A
 * known token updates its row (the restart path); an unknown one may create a
 * row only when it equals the instance anchor; anything else is a hint-free
 * refusal. `CHANNEL_ADAPTER_TOKEN` unset = nothing can ever register.
 *
 * Mint arm (`perInstance: true` — new binaries): the anchor is a membership
 * PROOF, never the instance's identity. A fresh per-instance `cha_` credential
 * is minted and the row is keyed by the instance's stable NAME: a restart
 * re-registers under the same name and takes over its old row, so the
 * `adapterId` — and every presence-ownership lease hanging off it — survives
 * and a compose restart resumes with zero handoff dead time. Two LIVE
 * same-named instances displace each other's token instead; the displaced
 * side's next call answers 401 and the client re-registers once under a
 * self-suffixed name (the documented disambiguation rule).
 */
export const registerAdapter = async (input: {
  token: string;
  name: string;
  perInstance?: boolean;
}): Promise<RegisterAdapterResult> => {
  if (!input.perInstance) {
    const existing = await db.channelAdapter.findUnique({
      where: { token: input.token },
      select: { id: true },
    });
    if (existing) {
      await db.channelAdapter.update({
        where: { id: existing.id },
        data: { name: input.name, lastSeenAt: new Date() },
      });
      return { ok: true, adapterId: existing.id };
    }

    if (
      !CHANNEL_ADAPTER_TOKEN ||
      !safeEqual(input.token, CHANNEL_ADAPTER_TOKEN)
    ) {
      return { ok: false };
    }

    const created = await db.channelAdapter.create({
      data: { token: input.token, name: input.name, lastSeenAt: new Date() },
      select: { id: true },
    });
    return { ok: true, adapterId: created.id };
  }

  if (
    !CHANNEL_ADAPTER_TOKEN ||
    !safeEqual(input.token, CHANNEL_ADAPTER_TOKEN)
  ) {
    return { ok: false };
  }

  const mintedToken = `cha_${randomBytes(32).toString("hex")}`;
  const adapterId = await db.$transaction(async (tx) => {
    // Serialize same-name mints (the policy-service lock idiom): two
    // instances booting under one name must resolve to one steal ordering,
    // never two rows.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel-adapter-register:${input.name}`}))`;
    const existing = await tx.channelAdapter.findFirst({
      where: { name: input.name, kind: "instance" },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true },
    });
    if (existing) {
      await tx.channelAdapter.update({
        where: { id: existing.id },
        data: { token: mintedToken, lastSeenAt: new Date() },
      });
      return existing.id;
    }
    const created = await tx.channelAdapter.create({
      data: {
        token: mintedToken,
        name: input.name,
        kind: "instance",
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });
    return created.id;
  });

  // Opportunistic reap of long-dead instance rows — their presence leases
  // free via the owner FK's SetNull and a peer claims them on its next poll.
  // Detached: register is the boot path and must not fail on housekeeping.
  void db.channelAdapter
    .deleteMany({
      where: {
        kind: "instance",
        lastSeenAt: { lt: new Date(Date.now() - ADAPTER_REAP_AGE_MS) },
      },
    })
    .catch(() => {});

  return { ok: true, adapterId, mintedToken };
};

export const heartbeatAdapter = async (adapterId: string): Promise<void> => {
  await db.channelAdapter.update({
    where: { id: adapterId },
    data: { lastSeenAt: new Date() },
  });
};

/** The same liveness window the runner plane uses — one "offline" meaning. */
export const adapterLiveness = async (): Promise<{
  online: boolean;
  lastSeenAt: Date | null;
}> => {
  const latest = await db.channelAdapter.findFirst({
    orderBy: { lastSeenAt: "desc" },
    select: { lastSeenAt: true },
  });
  const lastSeenAt = latest?.lastSeenAt ?? null;
  return {
    online:
      lastSeenAt !== null &&
      Date.now() - lastSeenAt.getTime() <
        RUNNER_ONLINE_THRESHOLD_SECONDS * 1000,
    lastSeenAt,
  };
};

export interface AdapterPresenceConfig {
  presenceId: string;
  provider: ChannelProviderId;
  transport: ChannelTransport;
  status: string;
  externalId: string;
  identityRef: string | null;
  agent: {
    id: string;
    name: string;
    workspaceId: string;
    /** Public avatar URL (key-fenced) for `icon_url`, or null. */
    imageUrl: string | null;
  };
  tenant: { externalId: string; name: string | null };
  /** DECRYPTED provider credential JSON — the adapter is trusted machinery
   * on an authenticated channel; this is its working material. */
  credentialsJson: string | null;
  /** The gateway approvals key (plaintext — `api_keys.key` is plaintext by
   * design across the product; the fence is the adapter token). */
  approvalsKey: string | null;
  links: {
    id: string;
    conversationId: string;
    externalThreadId: string;
    kind: string;
    externalUserId: string | null;
    mirrorCursor: Date | null;
  }[];
}

export interface AdapterConfigFeed {
  presences: AdapterPresenceConfig[];
  /** Content hash — the adapter's cheap "did anything change" check. */
  etag: string;
}

/**
 * Everything the adapter must hold open or serve: every non-disabled
 * presence with its decrypted credentials, links, and approvals key.
 * `needs_attention` presences are included on purpose — only their approvals
 * are broken, and the DM must keep answering while the banner shows.
 */
export type AdapterConfigResult =
  | { notModified: true; etag: string }
  | ({ notModified: false } & AdapterConfigFeed);

/** How long a presence-ownership lease lives. Renewed by the owner's ~10s
 * config poll, so it survives three consecutive missed/failed polls plus
 * jitter before a peer may steal; worst-case failover on ungraceful death is
 * ~lease + one peer poll (≈55s), safely inside the 90s online window. The 2s
 * work poll deliberately does NOT renew — one renewal write per poll round,
 * not five. */
export const PRESENCE_LEASE_SECONDS = 45;

/** How often ONE process fires the stale-session sweep off the config poll
 * (~10s cadence per adapter). Per-process throttle, not a cluster lease: a
 * few concurrent sweeps are harmless (the clear is idempotent and the
 * batch is capped), so cheap beats coordinated here. */
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSessionSweepAt = 0;

/** Detached, throttled: the config poll is the one heartbeat that keeps
 * beating when threads are quiet — exactly when a leaked "working…" loader
 * has nothing else to clear it (plans/stuck-loader: the attach-vs-clear
 * race's backstop). Never awaited on the poll path. */
const maybeSweepStaleSessionReceipts = (): void => {
  const now = Date.now();
  if (now - lastSessionSweepAt < SESSION_SWEEP_INTERVAL_MS) return;
  lastSessionSweepAt = now;
  void sweepStaleSessionReceipts();
};

/**
 * The ownership pass — renew, then claim up to fair share, then shed the
 * excess — run at the top of every config poll. Claims follow the due-work
 * law: a CTE + `FOR UPDATE … SKIP LOCKED` (never a subquery `LIMIT`, which
 * Postgres silently ignores), so concurrent claimers split the unowned set
 * instead of blocking or double-claiming. Rebalance is fair-share with
 * VOLUNTARY shed — never steal-from-live, which would turn every renewal
 * into a CAS and yank live sockets; a joiner is fed within one poll round
 * whenever an incumbent sits ABOVE fair. (Ceil-based fair means incumbents
 * can all sit exactly AT fair with nothing to give — e.g. 3 adapters over 4
 * presences settle 2/2/0 — so an extra scale-out instance can idle until
 * presence counts change. Every presence stays served; load-balancing the
 * remainder is the tracked §3.17 follow-up, not a correctness gap.) Claim
 * prefers oldest-first and shed newest-first: disjoint ends, so the two arms
 * cannot ping-pong one presence.
 */
const runOwnershipPass = async (adapterId: string): Promise<void> => {
  // PROVIDER-BLIND, recorded as debt for provider #2: claims cover every
  // active presence regardless of provider, so an adapter build with no
  // runtime for some provider would still lease (and starve) its presences.
  // Before a second provider ships, registration must carry a capability
  // list and this pass must filter claims by it. Until then the adapter's
  // unknown-provider skip only wastes the lease, and one provider means the
  // situation cannot arise.
  await db.$transaction(async (tx) => {
    // RENEW what I own. Fenced on owner = me: a row a peer stole (my lease
    // lapsed) no longer matches, so a comeback never resurrects lost claims.
    await tx.$executeRaw`
      UPDATE agent_channels
      SET owner_lease_expires_at = now() + make_interval(secs => ${PRESENCE_LEASE_SECONDS})
      WHERE owner_adapter_id = ${adapterId}
        AND status IN ('active', 'needs_attention')`;

    // Fair share over LIVE adapters (self counted even if the liveness touch
    // is still in flight). The membership window is the LEASE window, not the
    // UI's 90s online window: a dead peer must leave the denominator at the
    // same moment its leases become stealable, or a survivor already sitting
    // at fair share would claim nothing until the corpse aged out of the
    // longer window — doubling failover to ~90-100s and stranding half the
    // fleet on every rolling deploy (each new task is a new name, so stopped
    // tasks' rows are never stolen, only aged out). Old anchor-identity
    // binaries share one row and therefore act as one claimant — their
    // internal twin-ness stays CAS-tolerated exactly as before.
    const [{ live }] = await tx.$queryRaw<[{ live: number }]>`
      SELECT count(*)::int AS live FROM channel_adapters
      WHERE last_seen_at > now() - make_interval(secs => ${PRESENCE_LEASE_SECONDS})
         OR id = ${adapterId}`;
    const [{ eligible }] = await tx.$queryRaw<[{ eligible: number }]>`
      SELECT count(*)::int AS eligible FROM agent_channels
      WHERE status IN ('active', 'needs_attention')`;
    const [{ owned }] = await tx.$queryRaw<[{ owned: number }]>`
      SELECT count(*)::int AS owned FROM agent_channels
      WHERE owner_adapter_id = ${adapterId}
        AND status IN ('active', 'needs_attention')`;
    const fair = Math.ceil(eligible / Math.max(1, live));

    if (owned < fair) {
      await tx.$executeRaw`
        WITH claimed AS (
          SELECT ac.id FROM agent_channels ac
          WHERE ac.status IN ('active', 'needs_attention')
            AND (ac.owner_adapter_id IS NULL OR ac.owner_lease_expires_at < now())
          ORDER BY ac.created_at ASC
          LIMIT ${fair - owned}
          FOR UPDATE OF ac SKIP LOCKED
        )
        UPDATE agent_channels ac
        SET owner_adapter_id = ${adapterId},
            owner_lease_expires_at = now() + make_interval(secs => ${PRESENCE_LEASE_SECONDS})
        FROM claimed c
        WHERE ac.id = c.id`;
    } else if (owned > fair) {
      await tx.$executeRaw`
        WITH shed AS (
          SELECT ac.id FROM agent_channels ac
          WHERE ac.owner_adapter_id = ${adapterId}
            AND ac.status IN ('active', 'needs_attention')
          ORDER BY ac.created_at DESC
          LIMIT ${owned - fair}
          FOR UPDATE OF ac SKIP LOCKED
        )
        UPDATE agent_channels ac
        SET owner_adapter_id = NULL,
            owner_lease_expires_at = NULL
        FROM shed s
        WHERE ac.id = s.id`;
    }
  });
};

/**
 * `ifNoneMatch` lets the caller skip the WORK, not just the bytes: the etag is
 * computed from the plain rows (identity + shape, never secrets), and when it
 * matches we return 304 BEFORE decrypting anything. Cloud crypto is a KMS call
 * per credential, and the adapter polls every ~10s — decrypting the whole fleet
 * each idle poll would be thousands of needless KMS calls a day.
 *
 * The feed serves the CALLER'S SLICE: presences it holds a live ownership
 * lease on (claimed at the top of this very call). Slice changes — claim,
 * shed, failover — bust the etag naturally because the row set changes.
 */
export const getAdapterConfig = async (
  caller: { adapterId: string; kind: string },
  ifNoneMatch?: string,
): Promise<AdapterConfigResult> => {
  await runOwnershipPass(caller.adapterId);
  maybeSweepStaleSessionReceipts();

  const rows = await db.agentChannel.findMany({
    where: {
      status: { in: ["active", "needs_attention"] },
      ownerAdapterId: caller.adapterId,
    },
    select: {
      id: true,
      provider: true,
      transport: true,
      status: true,
      externalId: true,
      identityRef: true,
      credentials: true,
      updatedAt: true,
      agent: {
        select: { id: true, name: true, workspaceId: true, imageKey: true },
      },
      integration: { select: { externalId: true, name: true } },
      apiKey: { select: { key: true } },
      threadLinks: {
        select: {
          id: true,
          conversationId: true,
          externalThreadId: true,
          kind: true,
          externalUserId: true,
          mirrorCursor: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Hash over identity + shape, not decrypted secrets: the etag travels in
  // logs and headers, and rotation of an unrelated field should not leak
  // through a secret-derived digest.
  const etag = createHash("sha256")
    .update(
      JSON.stringify([
        // The icon posture is a FEED INPUT (it decides whether imageUrl is
        // carried at all, and its origin), so it must bust the etag too — an
        // api-server redeployed with a changed API_URL would otherwise answer
        // notModified to a long-running adapter forever.
        publicApiUrl() ?? "",
        rows.map((r) => [
          r.id,
          r.status,
          r.transport,
          r.updatedAt?.toISOString?.() ?? "",
          // The avatar rides the config feed — a changed key must bust the
          // etag or the adapter serves the old icon until an unrelated change.
          r.agent.imageKey ?? "",
          // The cursor split: an ANCHOR-identity caller (old binary) seeds
          // its mirror-CAS expectations ONLY from this feed, so cursors must
          // keep busting its etag or a mid-history acquisition 304-freezes
          // into a CAS livelock. An INSTANCE caller has the client code that
          // reads `linkMirrorCursor` off each work item instead, so its etag
          // folds only link membership — a mirrored turn stops busting the
          // whole feed.
          caller.kind === "instance"
            ? r.threadLinks.map((l) => l.id)
            : r.threadLinks.map((l) => [
                l.id,
                l.mirrorCursor?.toISOString() ?? "",
              ]),
        ]),
      ]),
    )
    .digest("hex");

  if (ifNoneMatch && ifNoneMatch === etag) {
    return { notModified: true, etag };
  }

  // The icon URL is for the PROVIDER to fetch (Slack's `icon_url`), unlike
  // the browser-facing list/detail projections — a localhost/plain-http
  // origin is unreachable from Slack and shouldn't leak into its payloads,
  // so the feed carries the avatar only when the API origin is public HTTPS
  // (the posture is folded into the etag above for exactly this reason).
  const iconsServable = publicApiUrl() !== null;
  const presences: AdapterPresenceConfig[] = await Promise.all(
    rows.map(async (row) => ({
      presenceId: row.id,
      provider: row.provider as ChannelProviderId,
      transport: row.transport as ChannelTransport,
      status: row.status,
      externalId: row.externalId,
      identityRef: row.identityRef,
      agent: {
        id: row.agent.id,
        name: row.agent.name,
        workspaceId: row.agent.workspaceId,
        imageUrl: iconsServable
          ? agentImageUrlOrNull(row.agent.id, row.agent.imageKey)
          : null,
      },
      tenant: {
        externalId: row.integration.externalId,
        name: row.integration.name,
      },
      credentialsJson: row.credentials
        ? await decryptCached(row.credentials)
        : null,
      approvalsKey: row.apiKey?.key ?? null,
      links: row.threadLinks,
    })),
  );

  return { notModified: false, presences, etag };
};

/**
 * The adapter's conversation fence: a conversation is the adapter's business
 * iff a thread link binds it to some presence. Returns the link + workspace so
 * callers can read/stream without re-deriving anything.
 */
export const requireLinkedConversation = async (conversationId: string) => {
  const link = await db.channelThreadLink.findUnique({
    where: { conversationId },
    select: {
      id: true,
      kind: true,
      externalThreadId: true,
      externalUserId: true,
      mirrorCursor: true,
      agentChannel: {
        select: {
          id: true,
          provider: true,
          agent: { select: { id: true, workspaceId: true } },
        },
      },
    },
  });
  if (!link) throw new ServiceError("NOT_FOUND", "Conversation not found");
  return link;
};

/**
 * Compare-and-set the mirror cursor, so two adapter processes (a deploy
 * overlap, a stale twin) can never both claim the same catch-up work: the
 * loser's expectation no longer matches and its update writes nothing.
 *
 * STRICT progress required: `next > expect`. Without it, a claim where
 * `expect === next` (a stale work snapshot whose turn a twin already
 * advanced the cursor past) would "win" trivially and re-post an answer that
 * is already on the thread.
 */
export const advanceMirrorCursor = async (
  linkId: string,
  expect: Date | null,
  next: Date,
): Promise<boolean> => {
  if (expect !== null && next <= expect) return false;
  const updated = await db.channelThreadLink.updateMany({
    where: { id: linkId, mirrorCursor: expect },
    data: { mirrorCursor: next },
  });
  return updated.count === 1;
};

export interface AdapterWorkItem {
  linkId: string;
  presenceId: string;
  conversationId: string;
  externalThreadId: string;
  kind: string;
  turn: {
    id: string;
    status: string;
    source: string;
    userId: string | null;
    /** Display name of the person behind `userId`, for cross-surface
     * attribution ("(from the web — Jonathan)"). Resolved server-side. */
    userName: string | null;
    message: string;
    error: string | null;
    errorCode: string | null;
    /** The provider-opaque thread the turn arrived in, when finer than the
     * link's address (Slack: a DM thread). Null = answer at the link. */
    sourceThreadId: string | null;
    createdAt: Date;
    finishedAt: Date | null;
  };
  /** Mid-run follow-ups this turn consumed, oldest first — the mirror posts
   * the web-sourced ones so both surfaces show the same exchange. Each
   * carries its OWN author's display name: on a group thread the follow-up
   * author can differ from the turn's asker. */
  followUps: { message: string; source: string; userName: string | null }[];
  /** The link's stored mirror cursor when this item was served — the CAS-seed
   * floor for an instance that acquired the link mid-history (its etag no
   * longer folds cursors, so the config feed can't be its seed source). */
  linkMirrorCursor: Date | null;
}

export interface AdapterWork {
  /** Finished turns past each link's mirror cursor — the completion pass
   * posts each exactly once (CAS-gated) and advances the cursor. */
  finished: AdapterWorkItem[];
}

const workTurnSelect = {
  id: true,
  status: true,
  source: true,
  userId: true,
  message: true,
  error: true,
  errorCode: true,
  // Where the turn was asked, when finer than the link's address (a DM
  // thread) — the completion pass answers THERE.
  sourceThreadId: true,
  createdAt: true,
  finishedAt: true,
} as const;

/**
 * The batched pending-work poll (one call, one indexed query) that replaces
 * per-link polling: every finished turn awaiting its completion post, across
 * the CALLER'S linked conversations — the ownership claim (taken by the
 * config poll) shards this feed too, so each instance's per-link OR spans
 * only its slice. The adapter calls this every ~2s; the shape is the seam —
 * pace and push still evolve inside here.
 */
export const getAdapterWork = async (
  adapterId: string,
): Promise<AdapterWork> => {
  const links = await db.channelThreadLink.findMany({
    where: { agentChannel: { ownerAdapterId: adapterId } },
    select: {
      id: true,
      conversationId: true,
      externalThreadId: true,
      kind: true,
      mirrorCursor: true,
      createdAt: true,
      agentChannel: { select: { id: true, provider: true } },
    },
  });
  if (links.length === 0) return { finished: [] };

  const byConversation = new Map(links.map((l) => [l.conversationId, l]));

  // A turn's MIRROR-TIMELINE position is when it entered the active
  // timeline: its creation — or, for a promoted follow-up, its PROMOTION
  // (`promotedAt`). Flooring on bare `createdAt` would let the cursor pass a
  // follow-up that sat parked while later-created turns finished, and its
  // answer would then never post; `promotedAt` is stamped strictly after any
  // turn that finished while it waited, so the coalesced stamp stays
  // monotone under the cursor's CAS.
  const finishedTurns = await db.turn.findMany({
    where: {
      OR: links.flatMap((l) => {
        const floor = l.mirrorCursor ?? l.createdAt;
        return [
          {
            conversationId: l.conversationId,
            status: { in: ["done", "failed", "aborted"] },
            promotedAt: null,
            createdAt: { gt: floor },
          },
          {
            conversationId: l.conversationId,
            status: { in: ["done", "failed", "aborted"] },
            promotedAt: { gt: floor },
          },
        ];
      }),
    },
    select: { ...workTurnSelect, promotedAt: true, conversationId: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  // Ordered by the same effective stamp the cursor advances on — the SQL
  // orderBy above only shapes the take-200 cut (bounded catch-up; the next
  // poll continues).
  const timelineOf = (turn: { createdAt: Date; promotedAt: Date | null }) =>
    turn.promotedAt ?? turn.createdAt;
  finishedTurns.sort(
    (a, b) => timelineOf(a).getTime() - timelineOf(b).getTime(),
  );

  // The follow-ups each finished turn CONSUMED (`joined`), in one indexed
  // query for the whole batch: the mirror owes the provider the web-sourced
  // ones, or the thread would show an answer to messages it never saw.
  const joinedFollowUps =
    finishedTurns.length === 0
      ? []
      : await db.turn.findMany({
          where: {
            followUpOfTurnId: { in: finishedTurns.map((t) => t.id) },
            status: "joined",
          },
          select: {
            id: true,
            followUpOfTurnId: true,
            message: true,
            source: true,
            userId: true,
          },
          orderBy: { createdAt: "asc" },
        });

  // Who spoke, by name — one batched lookup for the cross-surface
  // attribution lines ("(from the web — Jonathan)"). Follow-up authors are
  // resolved too: on a group thread they can differ from the turn's asker,
  // and the mirror must not put one member's words under another's name.
  const userIds = [
    ...new Set(
      [...finishedTurns, ...joinedFollowUps]
        .map((t) => t.userId)
        .filter((id): id is string => !!id),
    ),
  ];
  const users =
    userIds.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        });
  // Display name or nothing — never an email-derived fallback: the mirror
  // posts this into a Slack thread whose audience is Slack-defined (guests,
  // external members), not fenced to workspace membership, so a member's
  // email local-part must not travel there. A name-less member mirrors as
  // the unnamed "(from the web)".
  const userNameById = new Map(users.map((u) => [u.id, u.name ?? null]));

  // Attachment names, batched for turns AND follow-ups: the mirror's WIRE
  // COPY of a message gains a "📎 name" line so an attachment-only web
  // message never mirrors as a dangling attribution — the stored
  // `turn.message` stays verbatim (the attribution law), only this
  // adapter-facing copy is decorated.
  const mirroredTurnIds = [
    ...finishedTurns.map((turn) => turn.id),
    ...joinedFollowUps.map((row) => row.id),
  ];
  const attachmentRows =
    mirroredTurnIds.length === 0
      ? []
      : await db.conversationAttachment.findMany({
          where: { turnId: { in: mirroredTurnIds } },
          select: { turnId: true, name: true },
          orderBy: { createdAt: "asc" },
        });
  const attachmentNamesByTurn = new Map<string, string[]>();
  for (const row of attachmentRows) {
    if (!row.turnId) continue;
    const list = attachmentNamesByTurn.get(row.turnId) ?? [];
    list.push(row.name);
    attachmentNamesByTurn.set(row.turnId, list);
  }
  const withAttachmentLine = (turnId: string, message: string): string => {
    const names = attachmentNamesByTurn.get(turnId);
    if (!names || names.length === 0) return message;
    const line = `📎 ${names.join(", ")}`;
    return message.length > 0 ? `${message}\n${line}` : line;
  };

  const followUpsByTarget = new Map<
    string,
    { message: string; source: string; userName: string | null }[]
  >();
  for (const row of joinedFollowUps) {
    if (!row.followUpOfTurnId) continue;
    const list = followUpsByTarget.get(row.followUpOfTurnId) ?? [];
    list.push({
      message: withAttachmentLine(row.id, row.message),
      source: row.source,
      userName: row.userId ? (userNameById.get(row.userId) ?? null) : null,
    });
    followUpsByTarget.set(row.followUpOfTurnId, list);
  }

  const toItem = (
    turn: (typeof finishedTurns)[number],
  ): AdapterWorkItem | null => {
    const link = byConversation.get(turn.conversationId);
    if (!link) return null;
    const { conversationId, promotedAt, ...rest } = turn;
    void promotedAt;
    return {
      linkId: link.id,
      presenceId: link.agentChannel.id,
      conversationId,
      externalThreadId: link.externalThreadId,
      kind: link.kind,
      // The adapter uses `createdAt` only as the cursor watermark, so it
      // carries the turn's mirror-timeline stamp (promotion-aware), not the
      // raw column.
      turn: {
        ...rest,
        userName: rest.userId ? (userNameById.get(rest.userId) ?? null) : null,
        message: withAttachmentLine(turn.id, rest.message),
        createdAt: timelineOf(turn),
      },
      followUps: followUpsByTarget.get(turn.id) ?? [],
      linkMirrorCursor: link.mirrorCursor,
    };
  };

  const finished = finishedTurns
    .map(toItem)
    .filter((item): item is AdapterWorkItem => item !== null);

  return { finished };
};

/**
 * The adapter's approval-poll health report: a 401 from the gateway means
 * the service key's owner lost workspace access — flip the presence so the
 * dashboard names the fix; a healthy poll flips it back.
 */
export const reportApprovalAuth = async (
  presenceId: string,
  healthy: boolean,
): Promise<void> => {
  if (healthy) {
    await db.agentChannel.updateMany({
      where: { id: presenceId, status: "needs_attention" },
      data: { status: "active" },
    });
    return;
  }
  await db.agentChannel.updateMany({
    where: { id: presenceId, status: "active" },
    data: { status: "needs_attention" },
  });
};

// ── Approval prompts: dedupe + the update handle, restart-safe ──────────────

export const claimApprovalPrompt = async (input: {
  approvalId: string;
  agentChannelId: string;
  externalThreadId: string;
  /** The gateway's own deadline, so a restart re-arms with the real expiry
   * instead of guessing (and marking a still-live approval timed-out early). */
  expiresAt: Date | null;
}): Promise<{ claimed: boolean }> => {
  try {
    await db.channelApprovalPrompt.create({
      data: {
        approvalId: input.approvalId,
        agentChannelId: input.agentChannelId,
        externalThreadId: input.externalThreadId,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    return { claimed: true };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { claimed: false };
    }
    throw err;
  }
};

export const recordApprovalPromptMessage = async (
  approvalId: string,
  externalMessageRef: string,
): Promise<void> => {
  await db.channelApprovalPrompt.updateMany({
    where: { approvalId },
    data: { externalMessageRef },
  });
};

export const settleApprovalPrompt = async (
  approvalId: string,
  state: "decided" | "expired",
): Promise<{
  externalMessageRef: string | null;
  externalThreadId: string;
} | null> => {
  const prompt = await db.channelApprovalPrompt.findUnique({
    where: { approvalId },
    select: { id: true, externalMessageRef: true, externalThreadId: true },
  });
  if (!prompt) return null;
  await db.channelApprovalPrompt.update({
    where: { id: prompt.id },
    data: { state },
  });
  return {
    externalMessageRef: prompt.externalMessageRef,
    externalThreadId: prompt.externalThreadId,
  };
};

/** Pending prompts of the CALLER'S slice, for re-arming expiry against the
 * real gateway deadline (`expiresAt`) rather than a guess — at boot, and on
 * every ownership acquisition (the feed is owner-scoped, so a failed-over
 * presence's stranded cards are re-armed by whoever inherits it). */
export const listUnsettledPrompts = async (adapterId: string) =>
  db.channelApprovalPrompt.findMany({
    where: { state: "pending", agentChannel: { ownerAdapterId: adapterId } },
    select: {
      approvalId: true,
      agentChannelId: true,
      externalThreadId: true,
      externalMessageRef: true,
      expiresAt: true,
      createdAt: true,
    },
  });
