import { db } from "@onecli/db";
import { getCrypto } from "../../providers";
import { MAX_AGENT_IMAGE_BYTES, setAgentImage } from "../agent-image-service";
import { channelProvider } from "./registry";
import type { ChannelProviderId } from "./types";
import { logger } from "../../lib/logger";
import { ServiceError } from "../errors";

const log = logger.child({ component: "channel-presence-icons" });

/** A double-click guard: one provider read per app per this many seconds. */
const ICON_SYNC_MIN_GAP_SECONDS = 3;

interface ClaimedPresence {
  id: string;
  credentials: string;
  iconUrl: string | null;
  iconSyncedUrl: string | null;
}

/**
 * The app card's "Sync image" button: read the agent's app icon from the
 * provider NOW and copy it onto the agent's own image. Slack sends apps no
 * event when their icon changes, so an explicit pull is how a change made
 * on Slack's settings page reaches OneCLI.
 *
 * - The read always refreshes `icon_url` (the attached card's face).
 * - The copy fires only for a real upload (never the provider's stock mark)
 *   that differs from the last one copied (`icon_synced_url`), so pressing
 *   Sync again without a change keeps an image replaced in OneCLI since.
 *
 * Fenced to the caller's workspace by the agent row (404 otherwise, like the
 * rest of the agent's channel surface). The claim stamps `icon_checked_at`
 * with raw SQL (never bumps `updatedAt`, a config-feed etag input) and is a
 * compare-and-set, so a double click reads the provider once; the press
 * that loses it answers `changed: false` and the winner reports the outcome.
 */
export const syncPresenceIcon = async (input: {
  workspaceId: string;
  agentId: string;
  provider: ChannelProviderId;
}): Promise<{ changed: boolean }> => {
  const provider = channelProvider(input.provider);
  const icon = provider.presenceIcon;
  if (!icon) {
    throw new ServiceError("NOT_FOUND", "This channel has no app icon");
  }
  const presence = await db.agentChannel.findFirst({
    where: {
      agentId: input.agentId,
      provider: input.provider,
      agent: { workspaceId: input.workspaceId },
      status: { in: ["active", "needs_attention"] },
      credentials: { not: null },
    },
    select: { id: true },
  });
  if (!presence) {
    throw new ServiceError("NOT_FOUND", "No connected app to sync from");
  }

  const row = await claim(presence.id);
  if (!row) return { changed: false };

  try {
    const url = await icon.read({
      credentialsJson: await getCrypto().decrypt(row.credentials),
    });
    if (url !== row.iconUrl) {
      await db.$executeRaw`
        UPDATE agent_channels SET icon_url = ${url} WHERE id = ${row.id}`;
    }
    if (!url || url === row.iconSyncedUrl) return { changed: false };
    const bytes = await icon.download(url, MAX_AGENT_IMAGE_BYTES);
    await setAgentImage(input.workspaceId, input.agentId, bytes);
    await db.$executeRaw`
      UPDATE agent_channels SET icon_synced_url = ${url} WHERE id = ${row.id}`;
    return { changed: true };
  } catch (err) {
    // No token or URL in the line. Releasing the claim lets an immediate
    // retry read again instead of landing inside the double-click window.
    log.info(
      { err: String(err), presenceId: row.id, provider: input.provider },
      "presence icon sync failed",
    );
    await db.$executeRaw`
      UPDATE agent_channels SET icon_checked_at = NULL WHERE id = ${row.id}`;
    // Our own refusals (an icon the image service rejects, an agent deleted
    // mid-sync) keep their words; anything else is the provider unreachable.
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(
      "UNPROCESSABLE",
      `Couldn't read the app icon from ${provider.displayName}. Try again in a moment.`,
    );
  }
};

/** Compare-and-set on the one row: stamp it only while it is still live and
 * outside the window (a detach between the lookup and here loses). */
const claim = async (id: string): Promise<ClaimedPresence | undefined> =>
  (
    await db.$queryRaw<ClaimedPresence[]>`
      UPDATE agent_channels
      SET icon_checked_at = now()
      WHERE id = ${id}
        AND status IN ('active', 'needs_attention')
        AND credentials IS NOT NULL
        AND (icon_checked_at IS NULL
             OR icon_checked_at
                < now() - make_interval(secs => ${ICON_SYNC_MIN_GAP_SECONDS}))
      RETURNING id, credentials,
                icon_url AS "iconUrl",
                icon_synced_url AS "iconSyncedUrl"`
  )[0];
