import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import { revokeServiceApiKey } from "../api-key-service";
import { channelProvider, isChannelProviderId } from "./registry";
import { withFreshIntegrationCredentials } from "./channel-integration-service";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 30;
// Slack requests have bounded retries/timeouts. Lease covers a full phase plus
// rotation/rename, and claims are taken one at a time, never a serial batch.
const LEASE_MS = 10 * 60 * 1000;
/** Written by `beginChannelReattach` onto a completed keep-app job: the
 * uninstall proof no longer holds once a fresh install may follow. Read only
 * as "not `completed`" by the enqueue stage decision. */
const STAGE_INSTALLATION_PENDING = "installation_pending";

const retentionDeadline = (): Date => new Date(Date.now() + RETENTION_MS);
const CLEAR_CLAIM = { claimToken: null, claimExpiresAt: null } as const;

/** The fields that pin a cleanup job to ONE app in ONE tenant. A job keyed by
 * `(provider, externalId)` must never be reused across a different presence,
 * integration, tenant, or workspace, whichever path finds it. */
interface CleanupIdentity {
  organizationId: string;
  workspaceId: string;
  integrationId: string;
  teamId: string;
  sourcePresenceId: string;
}

const assertCleanupIdentityMatches = (
  existing: CleanupIdentity,
  expected: CleanupIdentity,
): void => {
  if (
    existing.organizationId !== expected.organizationId ||
    existing.workspaceId !== expected.workspaceId ||
    existing.integrationId !== expected.integrationId ||
    existing.teamId !== expected.teamId ||
    existing.sourcePresenceId !== expected.sourcePresenceId
  ) {
    throw new ServiceError("CONFLICT", "App cleanup identity mismatch");
  }
};

/** Workspace-wide ordering prevents attach/API-key FK operations racing any
 * agent or workspace cascade, including the low-level offboarding helper. */
export const lockChannelLifecycle = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> => {
  const [claim] = await tx.$queryRaw<
    { locked: boolean }[]
  >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`channel-lifecycle:${workspaceId}`}, 0)) AS locked`;
  if (!claim?.locked)
    throw new ServiceError(
      "CONFLICT",
      "A channel setup or deletion is in progress. Retry when it finishes.",
    );
};

const lifecycleContext = new AsyncLocalStorage<{
  tx: Prisma.TransactionClient;
  deadline: number;
}>();
/** Check after bounded remote work, before any further state mutation. A
 * Prisma transaction timeout does not itself cancel an async callback. */
export const assertChannelLifecycleHeld = async (
  requiredBudgetMs = 120_000,
) => {
  const context = lifecycleContext.getStore();
  if (!context) return;
  // Budget covers the complete next bounded Slack method (<=65s) plus
  // credential persistence. Keep another 60s margin below Prisma's timeout.
  if (context.deadline - Date.now() < requiredBudgetMs) {
    throw new ServiceError("CONFLICT", "Channel setup timed out. Retry setup.");
  }
  await context.tx.$queryRaw`SELECT 1`;
};

/** Attach ONLY: dedicated lock connection, no writes in this transaction.
 * Provider HTTP runs through the existing bounded client (65s per method).
 * The 10m budget exceeds the complete attach path. Local deletion never calls
 * network inside its transaction, but takes the same lock before snapshotting.
 */
export const withChannelLifecycle = <T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> =>
  db.$transaction(
    async (tx) => {
      await lockChannelLifecycle(tx, workspaceId);
      return lifecycleContext.run(
        { tx, deadline: Date.now() + 9 * 60_000 },
        fn,
      );
    },
    { timeout: 10 * 60 * 1000, maxWait: 10_000 },
  );

/** Row-lock an agent for the rest of the transaction, so a presence write
 * and the agent's own deletion cascade cannot interleave. With `workspaceId`
 * the lock doubles as the tenant fence: a foreign agent id locks nothing. */
export const lockAgentRow = async (
  tx: Prisma.TransactionClient,
  agentId: string,
  workspaceId?: string,
): Promise<void> => {
  if (workspaceId === undefined) {
    await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentId} FOR UPDATE`;
    return;
  }
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId} FOR UPDATE`;
};

/** Shared by every local attach/write and snapshot enqueue. The durable row
 * reserves the identity while remote I/O runs OUTSIDE the transaction. */
const lockChannelIdentity = async (
  tx: Prisma.TransactionClient,
  provider: string,
  externalId: string,
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`channel-cleanup:${provider}:${externalId}`}, 0))`;
};

export const assertChannelIdentityAvailable = async (
  tx: Prisma.TransactionClient,
  provider: string,
  externalId: string,
  presenceId?: string | null,
): Promise<void> => {
  await lockChannelIdentity(tx, provider, externalId);
  const cleanup = await tx.channelCleanup.findUnique({
    where: { provider_externalId: { provider, externalId } },
    select: { state: true, deleteRemote: true, sourcePresenceId: true },
  });
  if (
    cleanup &&
    (cleanup.state !== "completed" ||
      cleanup.deleteRemote ||
      cleanup.sourcePresenceId !== presenceId)
  ) {
    throw new ServiceError(
      "CONFLICT",
      "This app is reserved for remote cleanup. Finish cleanup or use a new app.",
    );
  }
};

/** A new setup URL or token exchange invalidates the previous uninstall
 * proof before the user/provider can install again. A failed activation may
 * leave a keyless pending shell, which is not proof it remains uninstalled. */
export const beginChannelReattach = async (
  tx: Prisma.TransactionClient,
  provider: string,
  externalId: string,
  presenceId?: string | null,
): Promise<void> => {
  await assertChannelIdentityAvailable(tx, provider, externalId, presenceId);
  await tx.channelCleanup.updateMany({
    where: { provider, externalId, state: "completed", deleteRemote: false },
    data: { stage: STAGE_INSTALLATION_PENDING },
  });
};

/** Only DB writes. Caller MUST delete/disable these presences in this same
 * transaction. Credentials are copied as ciphertext, never decrypted here.
 *
 * A `disabled` presence (the provider removed the app; `markPresenceRemoved`)
 * detached WITHOUT remote deletion gets no job: its token is already dead,
 * an uninstall attempt with it can only block, and a blocked job would
 * reserve the app id against the re-attach that `disabled` exists to allow.
 * With remote deletion requested the job is still enqueued and runs the
 * normal confirmed-uninstall gate: `disabled` does not record WHICH removal
 * signal fired, so it is not proof the installation is gone. */
export const enqueueChannelCleanup = async (
  tx: Prisma.TransactionClient,
  where: Prisma.AgentChannelWhereInput,
  deleteRemote = true,
): Promise<string[]> => {
  const rows = await tx.agentChannel.findMany({
    where,
    orderBy: { id: "asc" },
  });
  const ids: string[] = [];
  for (const candidate of rows) {
    await lockChannelIdentity(tx, candidate.provider, candidate.externalId);
    const presence = await tx.agentChannel.findUnique({
      where: { id: candidate.id },
      include: { integration: true, agent: { include: { workspace: true } } },
    });
    if (!presence) continue;
    if (presence.apiKeyId) await revokeServiceApiKey(presence.apiKeyId, tx);
    if (presence.status === "disabled" && !deleteRemote) continue;
    const identity: CleanupIdentity = {
      organizationId: presence.agent.workspace.organizationId,
      workspaceId: presence.agent.workspaceId,
      integrationId: presence.integrationId,
      teamId: presence.integration.externalId,
      sourcePresenceId: presence.id,
    };
    const existing = await tx.channelCleanup.findUnique({
      where: {
        provider_externalId: {
          provider: presence.provider,
          externalId: presence.externalId,
        },
      },
    });
    if (existing) assertCleanupIdentityMatches(existing, identity);
    if (existing && existing.state !== "completed") {
      // A detached shell can later be deleted locally without discarding its
      // outstanding uninstall or snapshot. Upgrade only the requested action.
      if (deleteRemote && !existing.deleteRemote) {
        await tx.channelCleanup.update({
          where: { id: existing.id },
          data: { deleteRemote: true },
        });
      }
      ids.push(existing.id);
      continue;
    }
    // `existing` here is null or a completed tombstone. A completed keep-app
    // job whose shell was never re-attached (stage still `completed`, not
    // `installation_pending`) already proved the uninstall: skip to manifest.
    const uninstallProven =
      existing?.stage === "completed" &&
      presence.status === "pending_setup" &&
      !presence.apiKeyId;
    const data = {
      ...identity,
      provider: presence.provider,
      externalId: presence.externalId,
      credentials: presence.credentials,
      deleteRemote,
      stage: uninstallProven ? "manifest" : "uninstall",
      state: "pending",
      reason: null,
      attempts: 0,
      nextAttemptAt: new Date(),
      ...CLEAR_CLAIM,
      expiresAt: retentionDeadline(),
    };
    const job = existing
      ? await tx.channelCleanup.update({ where: { id: existing.id }, data })
      : await tx.channelCleanup.create({ data });
    ids.push(job.id);
  }
  return ids;
};

/** Compensating snapshot if Slack created/exchanged credentials but the local
 * presence write failed. No parent FK, no plaintext, no new config owner. */
export const preserveUnattachedChannelApp = async (
  input: CleanupIdentity & {
    provider: string;
    externalId: string;
    credentials: string;
    retainAttached?: boolean;
  },
): Promise<void> =>
  db.$transaction(async (tx) => {
    await lockChannelIdentity(tx, input.provider, input.externalId);
    const live = await tx.agentChannel.findFirst({
      where: { provider: input.provider, externalId: input.externalId },
    });
    if (live && (!input.retainAttached || live.id !== input.sourcePresenceId))
      return;
    const { retainAttached, ...snapshot } = input;
    const interrupted = retainAttached === true;
    // A new compensation snapshot gets its own bounded cleanup budget, even
    // when this identity has an expired/completed tombstone.
    const data = {
      credentials: input.credentials,
      state: interrupted ? "blocked" : "pending",
      reason: interrupted ? "lifecycle_expired_manual_cleanup_required" : null,
      stage: "uninstall",
      deleteRemote: true,
      attempts: 0,
      nextAttemptAt: new Date(),
      ...CLEAR_CLAIM,
      expiresAt: retentionDeadline(),
    };
    const existing = await tx.channelCleanup.findUnique({
      where: {
        provider_externalId: {
          provider: input.provider,
          externalId: input.externalId,
        },
      },
    });
    if (existing) {
      assertCleanupIdentityMatches(existing, input);
      await tx.channelCleanup.update({ where: { id: existing.id }, data });
    } else {
      await tx.channelCleanup.create({ data: { ...snapshot, ...data } });
    }
  });

export const enqueueWorkspaceCleanup = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<string[]> => {
  // Prevent fresh agents/presences from appearing between the snapshot and
  // cascade. FK checks take KEY SHARE locks conflicting with these locks.
  await lockChannelLifecycle(tx, workspaceId);
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM agents WHERE workspace_id = ${workspaceId} ORDER BY id FOR UPDATE`;
  return enqueueChannelCleanup(tx, { agent: { workspaceId } });
};

/** Safe, bounded maintenance result contains counts ONLY, never job records. */
export const processChannelCleanups = async (
  options: { ids?: string[]; limit?: number } = {},
): Promise<{ completed: number; retained: number }> => {
  const counts = { completed: 0, retained: 0 };
  // A caller that enqueued nothing (an agent with no presences) has nothing
  // to process; the sweeps below belong to the maintenance pass.
  if (options.ids && options.ids.length === 0) return counts;
  // Eligible for purge at 30d, purged on the next maintenance pass. An offline
  // stack cannot enforce wall-clock erasure. Covers blocked/manual jobs too.
  // Never erase an in-flight worker's reservation or mark expiry successful.
  await db.channelCleanup.updateMany({
    where: {
      state: { not: "completed" },
      expiresAt: { lte: new Date() },
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: new Date() } }],
    },
    data: {
      credentials: null,
      state: "blocked",
      reason: "retention_expired_manual_cleanup_required",
      ...CLEAR_CLAIM,
    },
  });
  await db.channelCleanup.updateMany({
    where: {
      state: { in: ["pending", "retry"] },
      attempts: { gte: MAX_ATTEMPTS },
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: new Date() } }],
    },
    data: {
      state: "blocked",
      reason: "retry_limit_manual_cleanup_required",
      ...CLEAR_CLAIM,
    },
  });
  const idsFilter = options.ids
    ? Prisma.sql`AND id IN (${Prisma.join(options.ids)})`
    : Prisma.empty;
  for (let index = 0; index < Math.min(options.limit ?? 10, 25); index++) {
    const token = randomUUID();
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS);
    const claimed = await db.$queryRaw<{ id: string }[]>`
      WITH candidate AS (
        SELECT id FROM channel_cleanups
        WHERE state IN ('pending', 'retry') AND next_attempt_at <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND expires_at > (${now}::timestamptz AT TIME ZONE 'UTC') AND attempts < ${MAX_ATTEMPTS}
          AND (claim_expires_at IS NULL OR claim_expires_at < (${now}::timestamptz AT TIME ZONE 'UTC'))
          ${idsFilter}
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE channel_cleanups c SET claim_token = ${token}, claim_expires_at = (${until}::timestamptz AT TIME ZONE 'UTC'), attempts = attempts + 1
        FROM candidate WHERE c.id = candidate.id RETURNING c.id`;
    const id = claimed[0]?.id;
    if (!id) break;
    const job = await db.channelCleanup.findUniqueOrThrow({ where: { id } });
    const fence = () => ({
      id,
      claimToken: token,
      claimExpiresAt: { gt: new Date() },
    });
    // Renew immediately before each provider phase. Each Slack method is
    // bounded to 3*15s HTTP + 2*10s backoff, well below this full 10m lease.
    const valid = async () =>
      (
        await db.channelCleanup.updateMany({
          where: fence(),
          data: { claimExpiresAt: new Date(Date.now() + LEASE_MS) },
        })
      ).count === 1;
    const retain = async (reason: string, blocked = false) => {
      await db.channelCleanup.updateMany({
        where: fence(),
        data: {
          state: blocked || job.attempts >= MAX_ATTEMPTS ? "blocked" : "retry",
          reason:
            job.attempts >= MAX_ATTEMPTS
              ? "retry_limit_manual_cleanup_required"
              : reason,
          nextAttemptAt: new Date(
            Date.now() +
              Math.min(
                24 * 60 * 60 * 1000,
                60_000 * 2 ** Math.min(job.attempts, 10),
              ),
          ),
          ...CLEAR_CLAIM,
        },
      });
      counts.retained++;
    };
    try {
      // Check a live presence even though all attach paths honor reservations.
      // The sole permitted row is our disabled, keyless detached setup shell.
      const live = await db.agentChannel.findUnique({
        where: {
          provider_externalId: {
            provider: job.provider,
            externalId: job.externalId,
          },
        },
      });
      const shared = await db.channelInstallation.count({
        where: { provider: job.provider, appId: job.externalId },
      });
      if (
        shared ||
        (live &&
          (live.id !== job.sourcePresenceId ||
            live.status !== "pending_setup" ||
            live.apiKeyId !== null ||
            job.deleteRemote))
      ) {
        await retain("app_still_attached", true);
        continue;
      }
      // The column is a free string: a row from a build that knew a provider
      // this one does not has no hooks to call, and retrying cannot help.
      if (!isChannelProviderId(job.provider)) {
        await retain("unknown_provider", true);
        continue;
      }
      const providerId = job.provider;
      const provider = channelProvider(providerId);
      const credentialsJson = job.credentials
        ? await getCrypto().decrypt(job.credentials)
        : null;
      const withConfig = <T>(fn: (accessToken: string) => Promise<T>) =>
        withFreshIntegrationCredentials(
          job.organizationId,
          providerId,
          async (accessToken) => {
            if (!(await valid())) throw new Error("cleanup_claim_lost");
            return fn(accessToken);
          },
          { integrationId: job.integrationId, externalId: job.teamId },
        );
      if (job.stage === "uninstall") {
        // Cosmetic only. Never gate uninstall/deletion on rename propagation.
        const rename = provider.renameRemotePresence;
        if (job.deleteRemote && rename) {
          await withConfig((accessToken) =>
            rename({ accessToken, externalId: job.externalId }),
          ).catch(() => undefined);
        }
        if (!(await valid())) continue;
        const outcome = await provider.uninstallRemotePresence?.({
          credentialsJson,
        });
        if (outcome?.outcome !== "uninstalled") {
          await retain(
            outcome?.reason ?? "uninstall_unsupported",
            outcome?.outcome !== "retry",
          );
          continue;
        }
        // Persist success BEFORE manifest.delete. A crash cannot skip uninstall.
        const updated = await db.channelCleanup.updateMany({
          where: fence(),
          data: { stage: "manifest" },
        });
        if (!updated.count) continue;
      }
      // Re-read requested action: a concurrent local shell deletion may have
      // upgraded uninstall-only to manifest deletion during the remote call.
      const current = await db.channelCleanup.findUniqueOrThrow({
        where: { id },
      });
      if (current.deleteRemote) {
        const integration = await db.channelIntegration.findFirst({
          where: {
            id: job.integrationId,
            organizationId: job.organizationId,
            provider: job.provider,
            externalId: job.teamId,
          },
          select: { id: true },
        });
        if (!integration) {
          await retain(
            "integration_gone_manual_manifest_cleanup_required",
            true,
          );
          continue;
        }
        await withConfig((accessToken) =>
          provider.deleteRemotePresence({
            accessToken,
            externalId: job.externalId,
          }),
        );
      }
      const done = await db.channelCleanup.updateMany({
        where: { ...fence(), deleteRemote: current.deleteRemote },
        data: {
          state: "completed",
          stage: "completed",
          credentials: null,
          reason: null,
          ...CLEAR_CLAIM,
        },
      });
      if (!done.count) await retain("cleanup_action_changed");
      counts.completed += done.count;
    } catch {
      // No provider errors/credentials in logs or API responses.
      await retain("remote_cleanup_unavailable");
    }
  }
  return counts;
};
