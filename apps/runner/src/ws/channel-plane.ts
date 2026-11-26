import type { ControlPlaneClient } from "../control-plane";
import { log } from "../log";
import type { ChannelPlane } from "./server";

/**
 * The ws server's view of the control plane's channel records.
 *
 * - `claim` passes straight through: the server decides what a refusal or
 *   an outage means for each door.
 * - `containerOf` answers the container the control plane records for a
 *   sandbox (a session is verified against it). Concurrent lookups share
 *   one listing, so a whole fleet reconnecting at once after a copy rolls
 *   costs one request, not one per socket. Nothing is cached past it: the
 *   next lookup asks again.
 * - `release` must eventually land: lost, the control plane would keep
 *   naming this copy as the holder of a socket that is gone, and the
 *   sandbox's turns would wait for the reconciler instead of the reconnect.
 *   It is retried with backoff for a bounded budget; past it the
 *   reconciler's grace for a lost holder covers the rest. Releases are
 *   fenced by connection server-side, so a late one can never undo a newer
 *   claim.
 */

export interface ChannelPlaneOptions {
  client: Pick<
    ControlPlaneClient,
    "claimChannel" | "releaseChannel" | "listAssignedSandboxes"
  >;
  /** Injectable for tests (the retry backoff). */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only; production keeps the default budget. */
  releaseAttempts?: number;
}

const RELEASE_ATTEMPTS = 8;
const RELEASE_BACKOFF_MIN_MS = 500;
const RELEASE_BACKOFF_MAX_MS = 15_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export const createChannelPlane = ({
  client,
  sleep = defaultSleep,
  releaseAttempts = RELEASE_ATTEMPTS,
}: ChannelPlaneOptions): ChannelPlane & {
  /** Resolves once every release in flight has landed or given up. */
  settled(): Promise<void>;
} => {
  let listing: ReturnType<typeof client.listAssignedSandboxes> | undefined;
  const releases = new Set<Promise<void>>();

  const sharedListing = () => {
    if (!listing) {
      listing = client.listAssignedSandboxes().finally(() => {
        listing = undefined;
      });
    }
    return listing;
  };

  const releaseWithRetry = async (connectionId: string): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.releaseChannel(connectionId);
        return;
      } catch (error) {
        if (attempt >= releaseAttempts) {
          log("warn", "gave up releasing a closed channel", {
            connectionId,
            error: String(error),
          });
          return;
        }
        await sleep(
          Math.min(
            RELEASE_BACKOFF_MIN_MS * 2 ** (attempt - 1),
            RELEASE_BACKOFF_MAX_MS,
          ),
        );
      }
    }
  };

  return {
    claim: (claim) => client.claimChannel(claim),

    async containerOf(sandboxId) {
      const { channels } = await sharedListing();
      return channels?.[sandboxId]?.containerRef ?? undefined;
    },

    release(connectionId) {
      const pending = releaseWithRetry(connectionId);
      releases.add(pending);
      void pending.finally(() => releases.delete(pending));
    },

    async settled() {
      await Promise.all([...releases]);
    },
  };
};
