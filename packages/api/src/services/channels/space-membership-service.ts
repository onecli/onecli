import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { logger } from "../../lib/logger";
import { getCrypto } from "../../providers";
import { channelProvider, isChannelProviderId } from "./registry";
import { CHANNEL_PROVIDER_IDS } from "./types";
import {
  captureSpaceDeparture,
  commitSpaceDeparture,
  type SpaceMembershipLease,
} from "./space-membership-lifecycle";
import {
  lockMembershipPresence,
  type MembershipPresence,
} from "./space-membership-state";

const log = logger.child({ component: "space-membership" });
const MINUTE = 60_000;
const PERIOD = 60 * MINUTE;
const LEASE = 2 * MINUTE;
const MAX_PRESENCES = 25;
const MAX_CALLS = 50;
const MAX_PRESENCE_CALLS = 10;
const MAX_METADATA_READS = 40;
const MAX_RUN_METADATA_READS = 200;
const MAX_CANDIDATES = 100;

type Source = "grant" | "link";
interface Progress {
  grant: string | null;
  link: string | null;
  next: Source;
}
interface Claim {
  presence: MembershipPresence;
  lease: SpaceMembershipLease;
  progress: Progress;
}

const grantWhere = (presence: MembershipPresence) => ({
  agentId: presence.agentId,
  integrationId: presence.integrationId,
  provider: presence.provider,
  subjectKind: "space",
  state: { not: "left" },
});

const due = (reason: "periodic" | "hint", presenceId?: string) => Prisma.sql`
  ac.status IN ('active', 'needs_attention')
  AND ac.credentials IS NOT NULL AND ac.credentials <> ''
  AND ci.provider = ac.provider
  ${presenceId ? Prisma.sql`AND ac.id = ${presenceId}` : Prisma.empty}
  AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
  AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())
  AND (s.last_attempt_at IS NULL OR s.last_attempt_at <=
       now() - make_interval(secs => ${reason === "hint" ? 60 : 3600}))
  AND (EXISTS (
    SELECT 1 FROM agent_reach_grants g
    WHERE g.agent_id = ac.agent_id AND g.integration_id = ac.integration_id
      AND g.provider = ac.provider AND g.subject_kind = 'space' AND g.state <> 'left'
  ) OR EXISTS (
    SELECT 1 FROM channel_thread_links l
    WHERE l.agent_channel_id = ac.id AND l.kind = 'group'
  ))`;

/** Claim rechecks eligibility and due state under the shared agent -> presence
 * lock order. No network or AgentChannel write occurs in this transaction. */
const claimPresence = async (
  id: string,
  provider: string,
  reason: "periodic" | "hint",
): Promise<Claim | null> =>
  db.$transaction(
    async (tx) => {
      // A busy candidate must not consume this run's whole deadline.
      await tx.$executeRaw`SET LOCAL lock_timeout = '150ms'`;
      const presence = await lockMembershipPresence(tx, id);
      if (
        !presence ||
        presence.provider !== provider ||
        !presence.credentials ||
        !["active", "needs_attention"].includes(presence.status) ||
        !isChannelProviderId(presence.provider) ||
        !channelProvider(presence.provider).reach?.spaceMembership
      ) {
        return null;
      }
      const integration = await tx.channelIntegration.findFirst({
        where: { id: presence.integrationId, provider: presence.provider },
        select: { id: true },
      });
      if (!integration) return null;
      const grant = await tx.agentReachGrant.findFirst({
        where: grantWhere(presence),
        select: { id: true },
      });
      if (!grant) {
        const link = await tx.channelThreadLink.findFirst({
          where: { agentChannelId: id, kind: "group" },
          select: { id: true },
        });
        if (!link) return null;
      }
      const state = await tx.channelSpaceReconciliation.upsert({
        where: { agentChannelId: id },
        create: { agentChannelId: id },
        update: {},
      });
      const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      const now = clock[0]?.now;
      if (!now) return null;
      if (
        (state.leaseExpiresAt && state.leaseExpiresAt > now) ||
        (state.nextAttemptAt && state.nextAttemptAt > now) ||
        (state.lastAttemptAt &&
          state.lastAttemptAt.getTime() +
            (reason === "hint" ? MINUTE : PERIOD) >
            now.getTime())
      ) {
        return null;
      }
      const token = randomUUID();
      await tx.channelSpaceReconciliation.update({
        where: { agentChannelId: id },
        data: {
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE),
          lastAttemptAt: now,
          nextAttemptAt: new Date(now.getTime() + MINUTE),
        },
      });
      return {
        presence,
        lease: { token, generation: state.generation },
        progress: {
          grant: state.grantCursor,
          link: state.linkCursor,
          next: state.scanLinksNext ? "link" : "grant",
        },
      };
    },
    { timeout: 2_000, maxWait: 500 },
  );

/** Every row, including duplicates and stale captures, pays its cursor debt
 * before the next row is inspected. A rotated/expired owner cannot advance it.
 * Retry-After only raises the existing floor, including on final release. */
const persistProgress = async (
  claim: Claim,
  retryAfterMs?: number,
): Promise<boolean> => {
  const floor =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
      ? new Date(
          Date.now() +
            Math.max(0, Math.min(retryAfterMs, 8.64e15 - Date.now())),
        )
      : null;
  return (
    (await db.$executeRaw`
      UPDATE channel_space_reconciliations
      SET grant_cursor = ${claim.progress.grant},
          link_cursor = ${claim.progress.link},
          scan_links_next = ${claim.progress.next === "link"},
          next_attempt_at = CASE WHEN ${floor}::timestamptz IS NULL
            THEN next_attempt_at
            ELSE GREATEST(next_attempt_at, ${floor}::timestamptz) END
      WHERE agent_channel_id = ${claim.presence.id}
        AND generation = ${claim.lease.generation}
        AND lease_token = ${claim.lease.token} AND lease_expires_at > now()`) ===
    1
  );
};

const release = async (claim: Claim): Promise<void> => {
  await db.channelSpaceReconciliation.updateMany({
    where: {
      agentChannelId: claim.presence.id,
      generation: claim.lease.generation,
      leaseToken: claim.lease.token,
    },
    data: { leaseToken: null, leaseExpiresAt: null },
  });
};

/** Also bound an adapter which fails to honor its optional signal. Late probe
 * results have no mutation continuation, and cannot clean up after release. */
const untilAborted = async <T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T | null> => {
  if (signal.aborted) return null;
  let onAbort = () => {};
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** Reconcile a bounded slice of the grant/group-link UNION, not just approved
 * grants. Expired asks are not evidence of departure. Unsupported providers
 * are skipped before claiming. Counts are truthful: `probed` counts actual
 * provider invocations, `cleaned` counts successfully committed space cleanups,
 * NOT presences, rows inspected, duplicates, or attempted stale cleanups.
 *
 * Each source uses a durable ID keyset, wraps only on observed EOF, and is
 * visited at most once per invocation. Alternating one-row pages, with a
 * durable next-source turn, prevents a failing/busy source from starving its
 * peer. A finite, stable workset therefore drains across bounded passes even
 * when earlier rows forever answer member/unknown. Continuous insertion is
 * deliberately not promised an unbounded-throughput convergence guarantee.
 */
export const reconcileSpaceMemberships = async (options?: {
  presenceId?: string;
  reason?: "periodic" | "hint";
  signal?: AbortSignal;
}): Promise<{ probed: number; cleaned: number }> => {
  let probed = 0;
  let cleaned = 0;
  let claimed = 0;
  let metadataReads = 0;
  const reason = options?.reason ?? "periodic";
  const timeout = AbortSignal.timeout(MINUTE);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  if (signal.aborted) return { probed, cleaned };
  const providers = CHANNEL_PROVIDER_IDS.filter(
    (id) => channelProvider(id).reach?.spaceMembership,
  );
  if (providers.length === 0) return { probed, cleaned };
  const candidates = await db.$queryRaw<{ id: string; provider: string }[]>`
    SELECT ac.id, ac.provider FROM agent_channels ac
    JOIN channel_integrations ci ON ci.id = ac.integration_id
    LEFT JOIN channel_space_reconciliations s ON s.agent_channel_id = ac.id
    WHERE ${due(reason, options?.presenceId)}
      AND ac.provider IN (${Prisma.join(providers)})
    ORDER BY s.last_attempt_at ASC NULLS FIRST, ac.id
    LIMIT ${MAX_CANDIDATES}`;
  for (const candidate of candidates) {
    if (
      signal.aborted ||
      claimed >= MAX_PRESENCES ||
      probed >= MAX_CALLS ||
      metadataReads >= MAX_RUN_METADATA_READS
    )
      break;
    if (!isChannelProviderId(candidate.provider)) continue;
    const reach = channelProvider(candidate.provider).reach;
    if (!reach?.spaceMembership) continue;
    let claim: Claim | null;
    try {
      claim = await claimPresence(candidate.id, candidate.provider, reason);
    } catch (err) {
      log.info(
        { err: String(err), presenceId: candidate.id },
        "membership claim deferred",
      );
      continue;
    }
    if (!claim) continue;
    claimed += 1;
    let calls = 0;
    let reads = 0;
    const exhausted = new Set<Source>();
    const seen = new Set<string>();
    try {
      while (
        !signal.aborted &&
        calls < MAX_PRESENCE_CALLS &&
        probed < MAX_CALLS &&
        reads < MAX_METADATA_READS &&
        metadataReads < MAX_RUN_METADATA_READS &&
        exhausted.size < 2
      ) {
        let source = claim.progress.next;
        if (exhausted.has(source))
          source = source === "grant" ? "link" : "grant";
        claim.progress.next = source === "grant" ? "link" : "grant";
        reads += 1;
        metadataReads += 1;
        const cursor = claim.progress[source];
        const row =
          source === "grant"
            ? await db.agentReachGrant.findFirst({
                where: {
                  ...grantWhere(claim.presence),
                  ...(cursor ? { id: { gt: cursor } } : {}),
                },
                orderBy: { id: "asc" },
                select: { id: true, externalRef: true },
              })
            : await db.channelThreadLink
                .findFirst({
                  where: {
                    agentChannelId: claim.presence.id,
                    kind: "group",
                    ...(cursor ? { id: { gt: cursor } } : {}),
                  },
                  orderBy: { id: "asc" },
                  select: { id: true, externalThreadId: true },
                })
                .then((link) =>
                  link
                    ? {
                        id: link.id,
                        externalRef: reach.spaceOf(link.externalThreadId),
                      }
                    : null,
                );
        if (!row) {
          exhausted.add(source);
          claim.progress[source] = null;
          if (!(await persistProgress(claim))) break;
          continue;
        }
        claim.progress[source] = row.id;
        if (!row.externalRef || seen.has(row.externalRef)) {
          if (!(await persistProgress(claim))) break;
          continue;
        }
        seen.add(row.externalRef);
        const snapshot = await captureSpaceDeparture(
          claim.presence.id,
          row.externalRef,
          claim.lease,
        );
        if (!snapshot) {
          // A same-generation disappeared row still advances. A generation
          // change makes this CAS fail, leaving the fresh cursor untouched.
          if (!(await persistProgress(claim))) break;
          continue;
        }
        if (signal.aborted) {
          await persistProgress(claim);
          break;
        }
        const credentialsJson = snapshot.presence.credentials
          ? await getCrypto().decrypt(snapshot.presence.credentials)
          : null;
        const verdict = await untilAborted(signal, () => {
          calls += 1;
          probed += 1;
          return reach
            .spaceMembership({
              credentialsJson,
              externalRef: row.externalRef,
              signal,
            })
            .catch((): { kind: "unknown" } => ({ kind: "unknown" }));
        });
        if (!verdict) {
          await persistProgress(claim);
          break;
        }
        if (verdict.kind === "gone" && !signal.aborted) {
          if (await commitSpaceDeparture(snapshot)) cleaned += 1;
        }
        if (
          !(await persistProgress(
            claim,
            verdict.kind === "unknown" && "retryAfterMs" in verdict
              ? verdict.retryAfterMs
              : undefined,
          ))
        ) {
          break;
        }
        if (verdict.kind === "unknown") break;
      }
    } catch (err) {
      log.info(
        { err: String(err), presenceId: candidate.id },
        "membership reconciliation deferred",
      );
      // A capture, commit, or source-read failure must not pin every future
      // run to the same source. If the database itself is unavailable, the
      // claimed cooldown still prevents a hot retry loop.
      await persistProgress(claim).catch((progressError: unknown) => {
        log.info(
          { err: String(progressError), presenceId: candidate.id },
          "membership progress deferred",
        );
      });
    } finally {
      await release(claim).catch((err: unknown) => {
        log.info(
          { err: String(err), presenceId: candidate.id },
          "membership lease release deferred",
        );
      });
    }
  }
  return { probed, cleaned };
};
