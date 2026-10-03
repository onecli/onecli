/**
 * The per-app verification cache behind the Slack inbound routes (events +
 * interactivity): signing secret, bot token, and the presence facts a
 * request needs, keyed by Slack app id. The DB read is cheap; the KMS decrypt
 * behind `getCrypto()` is not, and an unauthenticated webhook must not turn
 * one request into one KMS call.
 *
 * Its own module (rather than a `const` inside the route) so the presence
 * LIFECYCLE can reach it: when the workspace uninstalls an agent's app the
 * route must stop admitting events for that app id at once, not after the
 * TTL. The route reads through `get`/`set`; `invalidateInboundPresence` is
 * the provider hook's door (`slackProvider.onPresenceRemoved`).
 */

export interface InboundPresenceEntry {
  signingSecret: string;
  botToken: string | null;
  presenceId: string;
  identityRef: string | null;
  iconUrl: string | null;
}

/** The secret only changes on re-attach, so a short TTL is safe; a wrong or
 * rotated secret simply fails verification and is re-fetched next window. */
export const INBOUND_PRESENCE_TTL_MS = 60_000;

const cache = new Map<string, InboundPresenceEntry & { at: number }>();

export const getInboundPresence = (
  appId: string,
  now: number = Date.now(),
): InboundPresenceEntry | null => {
  const cached = cache.get(appId);
  if (!cached) return null;
  if (now - cached.at >= INBOUND_PRESENCE_TTL_MS) {
    cache.delete(appId);
    return null;
  }
  return cached;
};

export const setInboundPresence = (
  appId: string,
  entry: InboundPresenceEntry,
  now: number = Date.now(),
): void => {
  cache.set(appId, { ...entry, at: now });
};

/** Drop one app's entry — the presence was removed or detached. */
export const invalidateInboundPresence = (appId: string): void => {
  cache.delete(appId);
};

/** Test seam. */
export const resetInboundPresenceCacheForTests = (): void => {
  cache.clear();
};
