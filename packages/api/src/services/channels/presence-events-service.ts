import { db, Prisma } from "@onecli/db";
import { channelProvider } from "./registry";
import { withFreshIntegrationCredentials } from "./channel-integration-service";
import { CHANNEL_PROVIDER_IDS, type ChannelProviderId } from "./types";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "channel-presence-events" });

/** Connections served per pass (one app each, see below). A backlog drains
 * over the hourly passes rather than in one burst. */
const EVENTS_SYNC_LIMIT = 25;

/** How long a claimed app waits before another pass may try it again: long
 * enough that a refusal (no credential, a provider blip) is not retried
 * every pass, short enough that a fixed org catches up the same day. */
const EVENTS_SYNC_RETRY_SECONDS = 6 * 60 * 60;

/** The comparison key, as stored on the row. Order-sensitive on purpose:
 * ANY change to the provider's list re-syncs every app once. */
const eventsKey = (events: readonly string[]): string => events.join(",");

interface ClaimedApp {
  id: string;
  externalId: string;
  organizationId: string;
  integrationId: string;
  /** The connected tenant (Slack: team id) the app was made in. */
  tenantId: string;
}

/**
 * Bring every live agent app's inbound event subscription up to the
 * provider's current list: once per app, and again only when that list
 * changes. The subscription lives on the provider's side (Slack: the app
 * manifest), so a deploy that adds an event (the native Stop,
 * `agent_session_stopped`) reaches an EXISTING app only through this.
 *
 * Scope: active agent-flavor apps. A regular-flavor app predates the
 * agent-only switch and never gets the agent features these events serve.
 *
 * ONE APP PER CONNECTION PER PASS: the provider meters config writes per
 * calling credential (Slack: `apps.manifest.update` is Tier 1, about one a
 * minute), and every app of an org shares that org's credential. The
 * hourly pass stays far inside the limit; an org with several apps
 * converges over consecutive passes.
 *
 * The claim is the `syncedEvents` / `eventsSyncAttemptedAt` pair, both RAW
 * SQL (a Prisma write would bump `updatedAt`, a config-feed etag input, and
 * every app's config would re-download for a change it does not read). A
 * success records the list it applied, which takes the app out of the
 * candidate set until the list changes again; a refusal leaves only the
 * attempt stamp, which parks the app until the retry window passes.
 *
 * Best-effort and never throws per app: an app left behind keeps working,
 * it only lacks the newest events (Slack: the loader has no Stop button).
 */
export const syncPresenceEvents = async (): Promise<{
  synced: number;
  deferred: number;
}> => {
  let synced = 0;
  let deferred = 0;
  for (const providerId of CHANNEL_PROVIDER_IDS) {
    const events = channelProvider(providerId).presenceEvents;
    if (!events) continue;
    const key = eventsKey(events.current);
    const due = duePredicate(providerId, key);
    for (const candidate of await pickCandidates(due)) {
      // Claimed one at a time, right before its work: the stamp says when
      // this app was actually tried, and a pass that dies midway parks
      // only the app it was on.
      const app = await claim(candidate, due);
      if (!app) continue; // a racing pass took it first
      try {
        // Pinned to the connection the app was made under (the cleanup
        // worker's guard): a credential from a replaced integration or a
        // reconnected tenant must never edit this app.
        await withFreshIntegrationCredentials(
          app.organizationId,
          providerId,
          (accessToken) =>
            events.sync({ accessToken, externalId: app.externalId }),
          { integrationId: app.integrationId, externalId: app.tenantId },
        );
        await db.$executeRaw`
          UPDATE agent_channels SET synced_events = ${key} WHERE id = ${app.id}`;
        synced += 1;
      } catch (err) {
        // No credential to update with (an org that never connected one, a
        // shared install without the minting grant), or the provider
        // refused. The attempt stamp already parks the app; nothing else
        // is owed.
        log.info(
          { err: String(err), presenceId: app.id, provider: providerId },
          "presence event sync deferred",
        );
        deferred += 1;
      }
    }
  }
  return { synced, deferred };
};

/** One predicate for picking and for claiming: the claim re-checks it.
 * Due = never tried, tried outside the retry window, or tried BEFORE the
 * org's credential last changed: an org that connects (or re-connects) its
 * credential after a deferral must not wait out the window it was parked in
 * for lacking one. Bounded: the stamp moves to now() on every claim, so the
 * credential arm fires once per credential change (a paste, or a rotation,
 * which is itself rate-bounded), never in a loop. */
const duePredicate = (providerId: ChannelProviderId, key: string) => Prisma.sql`
  ac.provider = ${providerId}
  AND ac.status IN ('active', 'needs_attention')
  AND ac.app_mode = 'agent'
  AND ac.synced_events IS DISTINCT FROM ${key}
  AND (ac.events_sync_attempted_at IS NULL
       OR ac.events_sync_attempted_at
          < now() - make_interval(secs => ${EVENTS_SYNC_RETRY_SECONDS})
       OR ci.credentials_rotated_at > ac.events_sync_attempted_at)`;

/** The oldest-tried due app of each connection. A plain read: rows other
 * passes hold (the adapters' lease renewals touch these every poll) are
 * still seen, never skipped. */
const pickCandidates = async (due: Prisma.Sql): Promise<string[]> =>
  (
    await db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (ac.integration_id) ac.id
      FROM agent_channels ac
      JOIN channel_integrations ci ON ci.id = ac.integration_id
      WHERE ${due}
      ORDER BY ac.integration_id,
               ac.events_sync_attempted_at ASC NULLS FIRST, ac.id
      LIMIT ${EVENTS_SYNC_LIMIT}`
  ).map((row) => row.id);

/**
 * Compare-and-set on ONE row: stamp it only if it is still due. A row held
 * by another transaction (a lease renewal, a racing pass) is waited on for
 * that transaction's few milliseconds, then re-checked, so racing passes
 * stay disjoint without skipping anything. One row per statement means no
 * lock-order cycle with the multi-row lease pass.
 */
const claim = async (
  id: string,
  due: Prisma.Sql,
): Promise<ClaimedApp | undefined> =>
  (
    await db.$queryRaw<ClaimedApp[]>`
      UPDATE agent_channels ac
      SET events_sync_attempted_at = now()
      FROM channel_integrations ci
      WHERE ac.id = ${id} AND ci.id = ac.integration_id AND ${due}
      RETURNING ac.id, ac.external_id AS "externalId",
                ci.organization_id AS "organizationId",
                ci.id AS "integrationId", ci.external_id AS "tenantId"`
  )[0];
