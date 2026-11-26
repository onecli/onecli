import { db, Prisma } from "@onecli/db";
import { logger } from "../../lib/logger";
import { channelProvider, isChannelProviderId } from "./registry";
import {
  lockMembershipPresence,
  type MembershipPresence,
} from "./space-membership-state";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  AUDIT_STATUS,
} from "../audit-service";

const log = logger.child({ component: "space-membership" });

export interface SpaceMembershipLease {
  token: string;
  generation: string;
}

const grantSelect = {
  id: true,
  revision: true,
  state: true,
  provider: true,
  cardRefs: true,
  subjectLabel: true,
} satisfies Prisma.AgentReachGrantSelect;

export interface SpaceMembershipSnapshot {
  presence: MembershipPresence;
  generation: string;
  externalRef: string;
  lease?: SpaceMembershipLease;
  grant: Prisma.AgentReachGrantGetPayload<{
    select: typeof grantSelect;
  }> | null;
}

interface SpaceRoutingSnapshot {
  count: number;
  digest: string;
}

export interface SpaceDepartureSnapshot extends SpaceMembershipSnapshot {
  routing: SpaceRoutingSnapshot;
}

const samePresence = (a: MembershipPresence, b: MembershipPresence): boolean =>
  a.id === b.id &&
  a.agentId === b.agentId &&
  a.integrationId === b.integrationId &&
  a.provider === b.provider &&
  a.externalId === b.externalId &&
  a.identityRef === b.identityRef &&
  a.credentials === b.credentials &&
  a.status === b.status;

const grantKey = (presence: MembershipPresence, externalRef: string) => ({
  agentId_integrationId_subjectKind_externalRef: {
    agentId: presence.agentId,
    integrationId: presence.integrationId,
    subjectKind: "space",
    externalRef,
  },
});

const spaceRoutingWhere = (
  presence: MembershipPresence,
  externalRef: string,
): Prisma.Sql | null => {
  if (!isChannelProviderId(presence.provider)) return null;
  const reach = channelProvider(presence.provider).reach;
  if (!reach) return null;
  const prefix = reach.spaceThreadPrefix(externalRef);
  return Prisma.sql`agent_channel_id = ${presence.id} AND kind = 'group'
    AND (external_thread_id = ${externalRef}
      OR left(external_thread_id, length(${prefix})) = ${prefix})`;
};

const captureMembership = async (
  tx: Prisma.TransactionClient,
  presenceId: string,
  externalRef: string,
  lease?: SpaceMembershipLease,
): Promise<SpaceMembershipSnapshot | null> => {
  const presence = await lockMembershipPresence(tx, presenceId);
  if (!presence || !["active", "needs_attention"].includes(presence.status))
    return null;
  const where = spaceRoutingWhere(presence, externalRef);
  if (!where) return null;
  const state = await tx.channelSpaceReconciliation.upsert({
    where: { agentChannelId: presenceId },
    create: { agentChannelId: presenceId },
    update: {},
  });
  if (
    lease &&
    (state.generation !== lease.generation ||
      state.leaseToken !== lease.token ||
      !state.leaseExpiresAt ||
      state.leaseExpiresAt.getTime() <= Date.now())
  )
    return null;
  const grant = await tx.agentReachGrant.findUnique({
    where: grantKey(presence, externalRef),
    select: grantSelect,
  });
  if (grant && grant.provider !== presence.provider) return null;
  return {
    presence,
    generation: state.generation,
    externalRef,
    lease,
    grant,
  };
};

/** Message admission only needs the lifecycle and grant fence. It must not
 * enumerate every thread in the room for each incoming message. */
export const captureSpaceMembership = async (
  presenceId: string,
  externalRef: string,
): Promise<SpaceMembershipSnapshot | null> =>
  db.$transaction((tx) => captureMembership(tx, presenceId, externalRef));

/** Keep the application snapshot constant-size even for a room with many
 * threads. PostgreSQL still scans the matching routing rows, but no row array
 * or proportional OR predicate crosses the database boundary. The ordered
 * digest includes revisions, so routing updates and delete/recreate ABA differ. */
const captureRouting = async (
  tx: Prisma.TransactionClient,
  presence: MembershipPresence,
  externalRef: string,
): Promise<SpaceRoutingSnapshot> => {
  const where = spaceRoutingWhere(presence, externalRef);
  if (!where) throw new Error("Missing membership provider facet");
  const [routing] = await tx.$queryRaw<SpaceRoutingSnapshot[]>`
    SELECT COUNT(*)::integer AS count,
      encode(sha256(convert_to(COALESCE(
        string_agg(id || ':' || revision::text, ',' ORDER BY id), ''
      ), 'UTF8')), 'hex') AS digest
    FROM channel_thread_links
    WHERE ${where}`;
  if (!routing) throw new Error("Missing space routing snapshot");
  return routing;
};

export const captureSpaceDeparture = async (
  presenceId: string,
  externalRef: string,
  lease?: SpaceMembershipLease,
): Promise<SpaceDepartureSnapshot | null> =>
  db.$transaction(async (tx) => {
    const membership = await captureMembership(
      tx,
      presenceId,
      externalRef,
      lease,
    );
    if (!membership) return null;
    return {
      ...membership,
      routing: await captureRouting(tx, membership.presence, externalRef),
    };
  });

/** The caller already holds agent and parent-presence row locks. Versions,
 * not dates or state names, detect a decision or routing ABA during HTTP. */
export const spaceMembershipStillCurrent = async (
  tx: Prisma.TransactionClient,
  snapshot: SpaceMembershipSnapshot,
  current: MembershipPresence,
): Promise<boolean> => {
  if (!samePresence(current, snapshot.presence)) return false;
  const state = await tx.channelSpaceReconciliation.findUnique({
    where: { agentChannelId: current.id },
  });
  if (!state || state.generation !== snapshot.generation) return false;
  if (
    snapshot.lease &&
    (state.leaseToken !== snapshot.lease.token ||
      !state.leaseExpiresAt ||
      state.leaseExpiresAt.getTime() <= Date.now())
  )
    return false;
  if (snapshot.grant) {
    await tx.$queryRaw`SELECT id FROM agent_reach_grants WHERE id = ${snapshot.grant.id} FOR UPDATE`;
  }
  const grant = await tx.agentReachGrant.findUnique({
    where: grantKey(current, snapshot.externalRef),
    select: grantSelect,
  });
  return (
    (!grant || grant.provider === current.provider) &&
    grant?.id === snapshot.grant?.id &&
    grant?.revision === snapshot.grant?.revision
  );
};

class StaleSpaceSnapshot extends Error {}

/** Commit only local effects atomically. Never re-resolve a replacement grant
 * and never settle provider cards while a database transaction is open. */
export const commitSpaceDeparture = async (
  snapshot: SpaceDepartureSnapshot,
): Promise<boolean> => {
  const { presence, externalRef } = snapshot;
  if (!isChannelProviderId(presence.provider)) return false;
  const provider = presence.provider;
  const result = await db
    .$transaction(async (tx) => {
      const current = await lockMembershipPresence(tx, presence.id);
      if (
        !current ||
        !(await spaceMembershipStillCurrent(tx, snapshot, current))
      ) {
        return null;
      }
      const where = spaceRoutingWhere(current, externalRef);
      if (!where) return null;
      // The presence lock prevents a new FK-bound link from appearing while we
      // compare the complete set. Participating writers also take the agent lock.
      const routing = await captureRouting(tx, current, externalRef);
      if (
        routing.count !== snapshot.routing.count ||
        routing.digest !== snapshot.routing.digest
      )
        return null;

      const needsPark = snapshot.grant?.state !== "left";
      if (!needsPark && routing.count === 0) return null;
      // The provider initiated this change. Attribute automatic maintenance
      // to the org owner, not an invented system user or an invitee. Refuse
      // anomalous ownerless data rather than commit an unaudited mutation.
      const owner = await tx.organizationMember.findFirst({
        where: {
          organizationId: current.agent.workspace.organizationId,
          role: "owner",
        },
        select: { user: { select: { id: true, email: true } } },
      });
      if (!owner) throw new Error("Membership cleanup requires an audit owner");
      let grantId = snapshot.grant?.id;
      let revision = snapshot.grant?.revision ?? 0;
      if (snapshot.grant && needsPark) {
        const parked = await tx.agentReachGrant.updateMany({
          where: { id: snapshot.grant.id, revision: snapshot.grant.revision },
          data: {
            state: "left",
            listen: "mentions",
            revision: { increment: 1 },
          },
        });
        if (parked.count !== 1) throw new StaleSpaceSnapshot();
        revision += 1;
      } else if (!snapshot.grant) {
        // Link-only legacy spaces need a tombstone too: a message admitted
        // before this cleanup must not recreate their routing after commit.
        const parked = await tx.agentReachGrant.create({
          data: {
            agentId: presence.agentId,
            integrationId: presence.integrationId,
            provider,
            subjectKind: "space",
            externalRef,
            state: "left",
            listen: "mentions",
          },
          select: { id: true, revision: true },
        });
        grantId = parked.id;
        revision = parked.revision;
      }
      if (routing.count > 0) {
        const removed = await tx.$executeRaw`
          DELETE FROM channel_thread_links WHERE ${where}`;
        if (removed !== routing.count) throw new StaleSpaceSnapshot();
      }

      await tx.auditLog.create({
        data: {
          workspaceId: current.agent.workspaceId,
          userId: owner.user.id,
          userEmail: owner.user.email,
          action: AUDIT_ACTIONS.UPDATE,
          service: AUDIT_SERVICES.CHANNEL,
          status: AUDIT_STATUS.SUCCESS,
          source: AUDIT_SOURCE.API,
          metadata: {
            automated: true,
            reason: "membership_lost",
            agentId: current.agentId,
            presenceId: current.id,
            externalRef,
            removedLinks: routing.count,
          },
        },
      });
      return { grantId, revision, needsPark };
    })
    .catch((error: unknown) => {
      if (error instanceof StaleSpaceSnapshot) return null;
      throw error;
    });
  if (!result) return false;
  if (result.needsPark && snapshot.grant && result.grantId) {
    const { settleParkedReachCards } = await import("./agent-reach-service");
    void settleParkedReachCards({
      grantId: result.grantId,
      expectedRevision: result.revision,
      state: "left",
      provider,
      agentId: presence.agentId,
      integrationId: presence.integrationId,
      cardRefs: snapshot.grant.cardRefs,
      subjectLabel: snapshot.grant.subjectLabel,
      externalRef,
      rewriteCards: snapshot.grant.state === "pending",
    }).catch((err: unknown) =>
      log.warn({ presenceId: presence.id, err }, "leave card settle failed"),
    );
  }
  return true;
};
