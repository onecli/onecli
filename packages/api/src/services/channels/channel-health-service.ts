import { db } from "@onecli/db";
import { logger } from "../../lib/logger";
import { getCrypto } from "../../providers";
import { channelProvider, isChannelProviderId } from "./registry";
import type { ChannelProviderId } from "./types";
import { noteOutboundFailure } from "./agent-channel-service";

const log = logger.child({ component: "channel-health" });

/**
 * A messaging connection that broke on the provider's side (Slack: the app
 * was uninstalled, deleted, or its token revoked): the bell's "Needs
 * attention" arm. Without it the only sign is the removed card on the
 * agent's own Channels tab, so an agent can sit silent for days unnoticed.
 */
export interface LostChannelConnectionItem {
  /** The presence id: stable, so the bell can key on it. */
  id: string;
  agentId: string;
  agentName: string;
  provider: ChannelProviderId;
  /** ISO: when the connection was marked lost. */
  lostAt: string;
}

/**
 * Lost connections in one workspace, newest first. The caller has already
 * fenced the workspace to people who can see it, and every one of them can
 * act on the alert: re-attaching an agent's app needs no org role.
 *
 * "Lost" = `disabled`, the status only the removal door
 * (`markPresenceRemoved`) writes; an owner's Detach leaves `pending_setup`
 * or deletes the row, so a detached agent never alerts. `lostAt` is the
 * row's `updatedAt`: the flip is the last Prisma write a disabled row takes
 * (a re-attach moves it out of `disabled`, the icon columns are written by
 * raw SQL, and the identity backfill needs a live token), so a later loss of
 * the same agent carries a new time.
 */
export const listLostChannelConnections = async (
  workspaceId: string,
): Promise<LostChannelConnectionItem[]> => {
  const rows = await db.agentChannel.findMany({
    where: { status: "disabled", agent: { workspaceId } },
    select: {
      id: true,
      agentId: true,
      provider: true,
      updatedAt: true,
      agent: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.flatMap((r) =>
    isChannelProviderId(r.provider)
      ? [
          {
            id: r.id,
            agentId: r.agentId,
            agentName: r.agent.name,
            provider: r.provider,
            lostAt: r.updatedAt.toISOString(),
          },
        ]
      : [],
  );
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Presences probed per hourly tick: a large install base spreads its lap
 * across ticks (200 an hour is 4,800 a day) instead of one burst. */
const BATCH_SIZE = 200;

/**
 * The lap, in-process: the adapter's maintenance call arrives about hourly,
 * and each call probes the next batch in id order until every live presence
 * has been probed; a new lap starts at most once a day. A restart starts a
 * fresh lap, and each api instance keeps its own: both only mean an extra
 * cheap probe, never a missed one.
 */
let lapStartedAt = 0;
let cursor: string | null = null;
let inFlight = false;

/**
 * The DAILY liveness check. A revoked token often produces no event at all
 * (the provider may have nowhere to deliver it), so an agent nobody messages
 * would never make the outbound call that notices. This asks the provider
 * "is this token alive?" for every live presence once a day and routes a
 * dead answer through the same removal door as any refused call, so the
 * bell, the agent's Channels tab and its tools all tell the same story.
 *
 * Only DEAD-credential answers flip anything (`noteOutboundFailure`'s rule):
 * a rate limit, a 5xx, a network blip or an unreadable credential is logged
 * and the lap moves on.
 */
export const checkChannelConnectionsDaily = async (
  opts: { now?: number; batchSize?: number } = {},
): Promise<{ checked: number; lost: number; skipped: boolean }> => {
  const now = opts.now ?? Date.now();
  const idle = cursor === null && now - lapStartedAt < DAY_MS;
  if (inFlight || idle) return { checked: 0, lost: 0, skipped: true };
  inFlight = true;
  try {
    if (cursor === null) {
      lapStartedAt = now;
      cursor = "";
    }
    const batchSize = opts.batchSize ?? BATCH_SIZE;
    const rows = await db.agentChannel.findMany({
      where: {
        status: { in: ["active", "needs_attention"] },
        id: { gt: cursor },
      },
      select: { id: true, provider: true, credentials: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    let checked = 0;
    let lost = 0;
    for (const row of rows) {
      if (!row.credentials || !isChannelProviderId(row.provider)) continue;
      const provider = channelProvider(row.provider);
      if (!provider.checkCredential) continue;
      checked += 1;
      try {
        await provider.checkCredential({
          credentialsJson: await getCrypto().decrypt(row.credentials),
        });
      } catch (err) {
        if (await noteOutboundFailure(row.id, err)) lost += 1;
        else
          log.info(
            { presenceId: row.id, err: String(err) },
            "daily connection check inconclusive",
          );
      }
    }
    cursor = rows.length < batchSize ? null : (rows.at(-1)?.id ?? null);
    return { checked, lost, skipped: false };
  } finally {
    inFlight = false;
  }
};

/** Test seam: forget the lap. */
export const resetDailyCheckForTests = () => {
  lapStartedAt = 0;
  cursor = null;
  inFlight = false;
};
