import { randomUUID } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { lockAgentRow } from "./channel-cleanup-service";

export const membershipPresenceSelect = {
  id: true,
  agentId: true,
  integrationId: true,
  provider: true,
  externalId: true,
  identityRef: true,
  credentials: true,
  status: true,
  agent: {
    select: {
      workspaceId: true,
      workspace: { select: { organizationId: true } },
    },
  },
} satisfies Prisma.AgentChannelSelect;

export type MembershipPresence = Prisma.AgentChannelGetPayload<{
  select: typeof membershipPresenceSelect;
}>;

/** All membership writers order locks agent -> presence -> maintenance state.
 * The parent row lock also fences non-participating credential/status writers.
 * This helper is only used in short, database-only transactions. */
export const lockMembershipPresence = async (
  tx: Prisma.TransactionClient,
  presenceId: string,
): Promise<MembershipPresence | null> => {
  const identity = await tx.agentChannel.findUnique({
    where: { id: presenceId },
    select: { agentId: true },
  });
  if (!identity) return null;
  await lockAgentRow(tx, identity.agentId);
  await tx.$queryRaw`SELECT id FROM agent_channels WHERE id = ${presenceId} FOR UPDATE`;
  return tx.agentChannel.findUnique({
    where: { id: presenceId },
    select: membershipPresenceSelect,
  });
};

/** Caller holds the agent row lock, as activation and membership writers do.
 * Rotating the generation invalidates old probes even on a no-op approved join.
 * Maintenance state never changes the presence's configuration etag. */
export const rotateSpaceMembershipGeneration = async (
  tx: Prisma.TransactionClient,
  agentChannelId: string,
): Promise<void> => {
  await tx.channelSpaceReconciliation.upsert({
    where: { agentChannelId },
    create: { agentChannelId },
    update: {
      generation: randomUUID(),
      grantCursor: null,
      linkCursor: null,
      scanLinksNext: false,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
};

export const noteSpaceMembershipJoin = async (
  presenceId: string,
): Promise<void> => {
  await db.$transaction(async (tx) => {
    const presence = await lockMembershipPresence(tx, presenceId);
    if (presence) await rotateSpaceMembershipGeneration(tx, presence.id);
  });
};
