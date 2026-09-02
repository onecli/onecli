import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import { channelProvider } from "./registry";
import type {
  ChannelProviderId,
  UserLinkSource,
  ValidatedIntegrationCredential,
} from "./types";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "channel-integration-service" });

/**
 * Org-level channel integrations: the link between an organization and one
 * provider tenant (Slack: the workspace), holding the OPTIONAL automation
 * credential (Slack: the rotating app-configuration token pair).
 *
 * Free models, deliberately apart from the EE org-credential store: no
 * `requireEnterprise`, no `getOrgAppConfig()`, no `app_configs` rows — the
 * separation the boundary review checks for (§3.16 placement note).
 */

const integrationSelect = {
  id: true,
  provider: true,
  externalId: true,
  name: true,
  credentials: true,
  credentialsRotatedAt: true,
  createdAt: true,
} as const;

export interface IntegrationView {
  provider: ChannelProviderId;
  externalId: string;
  name: string | null;
  /** A usable automation credential is stored. */
  hasCredentials: boolean;
  /**
   * The credential died (rotation refused) and needs a re-paste. DERIVED, not
   * a column: connected once (`credentialsRotatedAt` set) but `credentials`
   * now null. A paste-floor integration — never had a credential — reads
   * false here and `hasCredentials` false: absence, not failure.
   */
  needsCredentials: boolean;
  credentialsRotatedAt: Date | null;
  presenceCount: number;
}

export const getIntegrationView = async (
  organizationId: string,
): Promise<IntegrationView[]> => {
  const rows = await db.channelIntegration.findMany({
    where: { organizationId },
    select: {
      ...integrationSelect,
      _count: { select: { agentChannels: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    provider: row.provider as ChannelProviderId,
    externalId: row.externalId,
    name: row.name,
    hasCredentials: row.credentials !== null,
    needsCredentials:
      row.credentials === null && row.credentialsRotatedAt !== null,
    credentialsRotatedAt: row.credentialsRotatedAt,
    presenceCount: row._count.agentChannels,
  }));
};

/**
 * Connect (or re-connect) the org's automation credential for a provider.
 * The provider validates and normalizes the paste — for Slack, by rotating
 * it, which also names the workspace.
 */
export const connectIntegration = async (
  organizationId: string,
  provider: ChannelProviderId,
  rawCredential: string,
  actorUserId: string,
) => {
  const validated =
    await channelProvider(provider).connectIntegration(rawCredential);
  const encrypted = await getCrypto().encrypt(validated.credentialsJson);

  const existing = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: {
      id: true,
      externalId: true,
      _count: { select: { agentChannels: true } },
    },
  });

  if (existing && existing.externalId !== validated.tenant.externalId) {
    // A credential for a DIFFERENT workspace while presences live on the old
    // one would silently orphan every attached agent. Rebinding is a
    // deliberate act: detach first.
    if (existing._count.agentChannels > 0) {
      throw new ServiceError(
        "CONFLICT",
        `This token belongs to a different ${channelProvider(provider).displayName} workspace than the agents already attached here. Detach them first, or paste a token for the connected workspace.`,
      );
    }
    // Under the rotate lock: a paste replacing a pair mid-rotation must
    // serialize with that rotation, or the rotation's fenced write lands on
    // a row the paste just moved (the count-0 tripwire, not the design).
    await withIntegrationRotateLock(existing.id, (tx) =>
      tx.channelIntegration.update({
        where: { id: existing.id },
        data: {
          externalId: validated.tenant.externalId,
          name: validated.tenant.name,
          credentials: encrypted,
          credentialsRotatedAt: new Date(),
          createdByUserId: actorUserId,
        },
      }),
    );
    return { provider, tenant: validated.tenant };
  }

  if (existing) {
    // Same-workspace re-paste: same lock, same reason.
    await withIntegrationRotateLock(existing.id, (tx) =>
      tx.channelIntegration.update({
        where: { id: existing.id },
        data: { credentials: encrypted, credentialsRotatedAt: new Date() },
      }),
    );
    return { provider, tenant: validated.tenant };
  }

  // First connect: no row, so no rotation can be in flight for it. A racing
  // first connect resolves on the (organizationId, provider) unique.
  await db.channelIntegration.upsert({
    where: { organizationId_provider: { organizationId, provider } },
    create: {
      organizationId,
      provider,
      externalId: validated.tenant.externalId,
      name: validated.tenant.name,
      credentials: encrypted,
      credentialsRotatedAt: new Date(),
      createdByUserId: actorUserId,
    },
    update: {
      credentials: encrypted,
      credentialsRotatedAt: new Date(),
    },
  });
  return { provider, tenant: validated.tenant };
};

/**
 * Disconnect the org credential. Presences keep working — their tokens are
 * their own — so the row survives (links and tenant identity hang off it) with
 * the credential cleared; only an integration nothing references disappears
 * entirely.
 */
export const disconnectIntegration = async (
  organizationId: string,
  provider: ChannelProviderId,
): Promise<void> => {
  const existing = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: {
      id: true,
      _count: {
        select: { agentChannels: true, userLinks: true, installations: true },
      },
    },
  });
  if (!existing) throw new ServiceError("NOT_FOUND", "Integration not found");

  // Under the rotate lock: a disconnect is a deliberate revocation, and an
  // in-flight rotation's count-0 reconcile would otherwise read the unlocked
  // clear as "a stale refusal wiped my pair" and write the freshly rotated,
  // fully LIVE credential back — silently undoing the revocation.
  if (
    existing._count.agentChannels === 0 &&
    existing._count.userLinks === 0 &&
    // A live shared-app install rides this row too — deleting it would
    // cascade the installation away as a side effect of dropping a mere
    // automation credential.
    existing._count.installations === 0
  ) {
    await withIntegrationRotateLock(existing.id, (tx) =>
      tx.channelIntegration.delete({ where: { id: existing.id } }),
    );
    return;
  }
  await withIntegrationRotateLock(existing.id, (tx) =>
    tx.channelIntegration.update({
      where: { id: existing.id },
      // The timestamp goes WITH the credential: `needsCredentials` derives
      // "the token died" from `credentials == null && credentialsRotatedAt !=
      // null`, so leaving it would make a deliberate disconnect read as a
      // failure — and its absence is ALSO what tells the rotation reconcile
      // "this null is a revocation, never recover over it".
      data: { credentials: null, credentialsRotatedAt: null },
    }),
  );
};

/**
 * Per-integration mutual exclusion for every path that consumes or replaces
 * the stored credential pair. Slack's refresh half is SINGLE-USE: two
 * concurrent rotations of one row consume it twice, the loser's fenced clear
 * can land before the winner's slow (KMS) write, and the org's live
 * credential ends up nulled — a user-visible re-paste for no reason. The
 * advisory xact lock (the policy-service idiom; parameterized, never
 * concatenated) serializes rotate-vs-rotate, sweep-vs-on-use, and
 * paste-vs-rotate; every locked section RE-READS the row via `tx` and
 * re-decides before touching Slack. The transaction deliberately spans the
 * provider's rotate call (bounded by its 15s client timeout) — rotations are
 * rare (6h staleness) and the lock must cover read→rotate→persist or the
 * single-use half leaks out of the fence.
 */
const withIntegrationRotateLock = <T>(
  integrationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channel-integration-rotate:${integrationId}`}))`;
      return fn(tx);
    },
    // The 60s budget must outlive the WHOLE worst legitimate path — a prior
    // holder's full rotation (Slack's 15s client timeout + KMS retries) as
    // lock wait, then our own — because a tx that expires AFTER Slack
    // consumed the single-use refresh half rolls back the persist and bricks
    // the pair. maxWait (pool-connection acquisition) stays short: a
    // saturated pool should fail fast, not stack waiters.
    { timeout: 60_000, maxWait: 5_000 },
  );

type RotateRowOutcome =
  | { outcome: "rotated"; credentialsJson: string }
  | { outcome: "fresh"; credentialsJson: string }
  | { outcome: "cleared"; reason: "refused" | "foreign_tenant" }
  | { outcome: "gone" };

/**
 * The one locked rotate: re-read, re-decide, rotate, persist — shared by the
 * on-use path and the proactive sweep. `force` is the sweep's arm (rotate
 * regardless of expiry, but only when still STALE on the in-lock re-read: a
 * claim that lost to a concurrent on-use rotation must not burn the fresh
 * pair's single-use half for nothing).
 */
const rotateIntegrationRow = async (
  tx: Prisma.TransactionClient,
  integrationId: string,
  opts: { force: boolean; staleCutoff?: Date },
): Promise<RotateRowOutcome> => {
  const row = await tx.channelIntegration.findUnique({
    where: { id: integrationId },
    select: {
      id: true,
      provider: true,
      credentials: true,
      credentialsRotatedAt: true,
      externalId: true,
    },
  });
  if (!row?.credentials) return { outcome: "gone" };
  if (
    opts.force &&
    opts.staleCutoff &&
    row.credentialsRotatedAt &&
    row.credentialsRotatedAt >= opts.staleCutoff
  ) {
    // A concurrent on-use rotation refreshed it after our claim — no longer
    // stale, nothing to do.
    return { outcome: "fresh", credentialsJson: "" };
  }

  const crypto = getCrypto();
  const storedCiphertext = row.credentials;
  const credentialsJson = await crypto.decrypt(storedCiphertext);
  const impl = channelProvider(row.provider as ChannelProviderId);

  let rotated: ValidatedIntegrationCredential | null;
  try {
    rotated = await impl.rotateIntegrationCredential(
      credentialsJson,
      opts.force ? { force: true } : undefined,
    );
  } catch (err) {
    log.warn(
      { err, integrationId, provider: row.provider },
      "integration credential rotation refused; clearing for re-paste",
    );
    // Fenced on the ciphertext we read (a belt — under the lock nothing
    // should have moved it): a pair we didn't rotate from is never wiped.
    await tx.channelIntegration.updateMany({
      where: { id: row.id, credentials: storedCiphertext },
      data: { credentials: null },
    });
    return { outcome: "cleared", reason: "refused" };
  }

  if (rotated === null) return { outcome: "fresh", credentialsJson };

  if (rotated.tenant.externalId !== row.externalId) {
    // The rotation succeeded but named a workspace other than the one this
    // org is bound to. Persisting the pair would hand the org's automation
    // credential to a foreign tenant — and the stored pair is dead anyway
    // (the rotate consumed its refresh half) — so refuse exactly like a
    // dead credential: fenced clear, re-paste surfaced. The tenant binding
    // (`externalId`) is never rebound outside `connectIntegration`.
    log.warn(
      {
        integrationId,
        provider: row.provider,
        expected: row.externalId,
        actual: rotated.tenant.externalId,
      },
      "rotated integration credential names a different workspace; clearing",
    );
    await tx.channelIntegration.updateMany({
      where: { id: row.id, credentials: storedCiphertext },
      data: { credentials: null },
    });
    return { outcome: "cleared", reason: "foreign_tenant" };
  }

  const encrypted = await crypto.encrypt(rotated.credentialsJson);
  const { count } = await tx.channelIntegration.updateMany({
    where: { id: row.id, credentials: storedCiphertext },
    data: { credentials: encrypted, credentialsRotatedAt: new Date() },
  });
  if (count === 0) {
    // Should be impossible now that every writer takes the lock — this is
    // the mutation-tested tripwire for a writer that doesn't. Reconcile so
    // the freshly minted pair is never lost NOR clobbers a newer paste: a
    // null row means a stale refusal cleared it and ours is the only live
    // pair (recover it, still fenced on null); a different non-null value is
    // a newer paste, freshly validated by its own rotate — it wins.
    log.error(
      { integrationId },
      "integration credential moved under the rotate lock; reconciling",
    );
    const current = await tx.channelIntegration.findUnique({
      where: { id: row.id },
      select: { credentials: true, credentialsRotatedAt: true },
    });
    if (
      current?.credentials === null &&
      current.credentialsRotatedAt !== null
    ) {
      // A stale refusal's clear (nulls the credential, KEEPS the timestamp).
      // A deliberate disconnect nulls BOTH — that null is a revocation and is
      // never recovered over. Fenced on null so a paste landing this instant
      // still wins.
      await tx.channelIntegration.updateMany({
        where: {
          id: row.id,
          credentials: null,
          credentialsRotatedAt: { not: null },
        },
        data: { credentials: encrypted, credentialsRotatedAt: new Date() },
      });
    }
  }
  return { outcome: "rotated", credentialsJson: rotated.credentialsJson };
};

/**
 * Rotate-on-use: run `fn` with a fresh provider access token. The replacement
 * pair is persisted in ONE update before `fn` runs — the refresh half is
 * single-use, so a torn write (new pair in memory, old pair on disk) would
 * strand the org; encrypt-then-single-UPDATE cannot tear. The whole
 * read→rotate→persist runs under the per-integration lock; `fn` runs AFTER
 * it commits (it makes its own provider calls and must not extend the lock).
 *
 * A refused rotation clears the stored credential (the pair is dead — Slack
 * refresh tokens are consumed by the attempt) so the org page surfaces the
 * re-paste state, then throws the caller's error envelope.
 */
export const withFreshIntegrationCredentials = async <T>(
  organizationId: string,
  provider: ChannelProviderId,
  fn: (accessToken: string, integrationId: string) => Promise<T>,
): Promise<T> => {
  // FAST PATH (managed-apps arm): the provider's shared workspace install
  // may carry a credential that can mint agent apps — the same manifest API
  // the automation credential drives, minus the paste and the rotation.
  // The facet answers null (no shared app, no install, no usable token, or
  // a recorded may-not-mint refusal) to send us to the credential path; a
  // real `fn` error propagates — it must never run twice.
  const sharedApp = channelProvider(provider).sharedApp;
  if (sharedApp?.configured()) {
    const minted = await sharedApp.tryMintWith({ organizationId, fn });
    if (minted) return minted.result;
  }

  const row = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: { id: true, credentials: true },
  });
  if (!row?.credentials) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `The organization has no ${channelProvider(provider).displayName} automation token. Connect one in the org's Channels settings, or use the manifest flow instead.`,
    );
  }

  const result = await withIntegrationRotateLock(row.id, (tx) =>
    rotateIntegrationRow(tx, row.id, { force: false }),
  );

  if (result.outcome === "gone") {
    throw new ServiceError(
      "UNPROCESSABLE",
      `The organization has no ${channelProvider(provider).displayName} automation token. Connect one in the org's Channels settings, or use the manifest flow instead.`,
    );
  }
  if (result.outcome === "cleared") {
    if (result.reason === "foreign_tenant") {
      throw new ServiceError(
        "CONFLICT",
        `The stored ${channelProvider(provider).displayName} automation token belongs to a different workspace than the one connected to this organization. Paste a token for the connected workspace in the org's Channels settings.`,
      );
    }
    throw new ServiceError(
      "UNPROCESSABLE",
      `The stored ${channelProvider(provider).displayName} automation token has expired and could not be refreshed. Paste a fresh one in the org's Channels settings.`,
    );
  }

  const { accessToken } = JSON.parse(result.credentialsJson) as {
    accessToken: string;
  };
  return fn(accessToken, row.id);
};

/** Proactively rotate anything not rotated for this long. Half the 12h
 * access-token lifetime, so even a whole failed sweep leaves a full margin. */
const PROACTIVE_ROTATE_AGE_MS = 6 * 60 * 60 * 1000;

/** How long a sweep claim holds before a peer may re-claim the row: a
 * rotation is two bounded HTTP calls (≤ ~15s each), so 10 minutes covers
 * pathological latency while leaving nearly the whole 6h staleness margin
 * for a crashed claimer's retry. */
const ROTATE_CLAIM_LEASE_MS = 10 * 60 * 1000;

/** Bounded work per sweep pass; the next hourly pass continues. */
const ROTATE_SWEEP_LIMIT = 25;

/**
 * The proactive rotation sweep, called by the channel adapter (~hourly): keep
 * every stored integration credential fresh even when nothing USES it.
 * Exists because whether an unused refresh token outlives its access token is
 * undocumented (verified 2026-08-07) — lazy rotate-on-use alone would gamble
 * an idle org's credential on that silence.
 *
 * N adapter instances all sweep — so the pass first CLAIMS disjoint stale
 * rows (`rotate_claimed_at` lease + `FOR UPDATE SKIP LOCKED`, the claim-CTE
 * law), then rotates each under the per-integration lock, which re-checks
 * staleness in-lock. Each rotation invalidates the previous refresh token
 * (single-use), so "at most one rotation attempt per row anywhere" is the
 * invariant both layers exist for.
 */
export const rotateStaleIntegrations = async (): Promise<{
  rotated: number;
  failed: number;
}> => {
  const cutoff = new Date(Date.now() - PROACTIVE_ROTATE_AGE_MS);
  const claimCutoff = new Date(Date.now() - ROTATE_CLAIM_LEASE_MS);
  const claimed = await db.$queryRaw<{ id: string }[]>`
    WITH claimed AS (
      SELECT ci.id FROM channel_integrations ci
      WHERE ci.credentials IS NOT NULL
        AND (ci.credentials_rotated_at IS NULL OR ci.credentials_rotated_at < ${cutoff})
        AND (ci.rotate_claimed_at IS NULL OR ci.rotate_claimed_at < ${claimCutoff})
      ORDER BY ci.credentials_rotated_at ASC NULLS FIRST
      LIMIT ${ROTATE_SWEEP_LIMIT}
      FOR UPDATE OF ci SKIP LOCKED
    )
    UPDATE channel_integrations ci
    SET rotate_claimed_at = now()
    FROM claimed c
    WHERE ci.id = c.id
    RETURNING ci.id`;

  let rotated = 0;
  let failed = 0;
  for (const { id } of claimed) {
    try {
      const result = await withIntegrationRotateLock(id, (tx) =>
        rotateIntegrationRow(tx, id, { force: true, staleCutoff: cutoff }),
      );
      if (result.outcome === "rotated") rotated += 1;
      else if (result.outcome === "cleared") failed += 1;
      // "fresh" (a concurrent on-use rotation beat the claim) and "gone"
      // count as neither: nothing was owed.
    } catch (err) {
      // Transport/transaction failure. Usually the pair was not consumed (a
      // Slack refusal is handled inside as "cleared") and the claim lease
      // expiring lets a later sweep retry; the one bad tail — the tx expiring
      // AFTER Slack consumed the refresh half — loses the pair and surfaces
      // as a refused retry → re-paste, which the 60s budget exists to make
      // vanishingly rare.
      log.warn({ err, integrationId: id }, "proactive rotation pass failed");
      failed += 1;
    }
  }
  return { rotated, failed };
};

// ── User links: provider user ↔ platform user, per integration ──────────────

const userLinkSelect = {
  id: true,
  externalUserId: true,
  linkedVia: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

export const listUserLinks = async (organizationId: string) =>
  db.channelUserLink.findMany({
    where: { integration: { organizationId } },
    select: { ...userLinkSelect, integration: { select: { provider: true } } },
    orderBy: { createdAt: "asc" },
  });

/**
 * An explicit (admin-made) link. The target must be an ACTIVE member of this
 * org — a link is an authorization input, and pointing one at a foreign or
 * suspended user would let a provider identity borrow access nobody granted.
 */
export const addUserLink = async (
  organizationId: string,
  provider: ChannelProviderId,
  input: { externalUserId: string; userId: string },
  linkedVia: UserLinkSource = "manual",
) => {
  const integration = await db.channelIntegration.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
    select: { id: true },
  });
  if (!integration) {
    throw new ServiceError(
      "NOT_FOUND",
      "Connect the workspace before linking users",
    );
  }

  const membership = await db.organizationMember.findFirst({
    where: {
      organizationId,
      userId: input.userId,
      NOT: { status: "suspended" },
    },
    select: { userId: true },
  });
  if (!membership) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "That user is not an active member of this organization",
    );
  }

  try {
    return await db.channelUserLink.create({
      data: {
        integrationId: integration.id,
        externalUserId: input.externalUserId.trim(),
        userId: input.userId,
        linkedVia,
      },
      select: userLinkSelect,
    });
  } catch (err) {
    // Both uniques — (integration, externalUserId) and (integration, userId) —
    // surface a normal re-link attempt; a 409 is the honest answer, not a 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ServiceError(
        "CONFLICT",
        `That member or ${channelProvider(provider).displayName} account is already linked.`,
      );
    }
    throw err;
  }
};

export const removeUserLink = async (
  organizationId: string,
  linkId: string,
): Promise<void> => {
  // Fenced delete: the link must belong to this org's integration.
  const removed = await db.channelUserLink.deleteMany({
    where: { id: linkId, integration: { organizationId } },
  });
  if (removed.count === 0) {
    throw new ServiceError("NOT_FOUND", "Link not found");
  }
};
