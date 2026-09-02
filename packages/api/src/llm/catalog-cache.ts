import type { LlmProvider, ModelOption } from "./types";

/**
 * The model catalog, fetched live and cached in process.
 *
 * THE CREDENTIAL IS PASSED, USED, AND DROPPED. It is never logged, never
 * returned, and never stored on a cache entry.
 *
 * Keyed by the SECRET, not by the provider. A provider's `/v1/models` looks
 * like public product data and is not: both providers return the inventory
 * that KEY may use, which can include preview and allowlisted ids. Sharing one
 * entry across tenants would show one customer's early access to another, and
 * would let a tenant whose key was revoked pace everybody else's refresh with
 * its own failure backoff. Entries are small — a few hundred short strings —
 * and bounded by the number of granted LLM secrets on the instance.
 *
 * Never empty, in any state: live → stale → pinned. An empty dropdown is not a
 * legal answer, so every failure arm degrades to the next rung down rather
 * than surfacing an error.
 *
 * There is no warm-up at boot, on purpose (§3.10): a catalog fetch at import
 * would make the first seconds of every start depend on egress, and produce an
 * alarming rejection on every boot of a self-host without direct internet.
 */

const TTL_MS = 60 * 60 * 1000;
/**
 * How long a failed refresh suppresses the next one. Without it, every request
 * during a provider outage kicks off its own doomed fetch: past the TTL each
 * call takes the revalidate branch, and one failure does not stop the next.
 */
const RETRY_BACKOFF_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** A confused endpoint cannot balloon the cache. */
const MAX_MODELS = 200;

interface CacheEntry {
  models: ModelOption[];
  fetchedAt: number;
  /** Set when a refresh failed; observability only — staleness NEVER evicts. */
  staleSince?: number;
  /** Earliest time a further refresh may be attempted. */
  nextRetryAt?: number;
}

/** `${provider}:${secretId}` — see the header on why not the provider alone. */
type CacheKey = string;

const cache = new Map<CacheKey, CacheEntry>();
/**
 * Boxed so a flight can identify itself in its own `finally` — see `refresh`.
 * A bare promise cannot: it would have to reference the variable it is being
 * assigned to.
 */
interface Flight {
  promise: Promise<void>;
}
const inflight = new Map<CacheKey, Flight>();

/** Test seam. Production never clears the cache — stale beats empty. */
export const resetModelCatalogCache = (): void => {
  cache.clear();
  inflight.clear();
};

const pinned = (provider: LlmProvider): ModelOption[] =>
  provider.fallback.map((id) => ({
    id,
    label: provider.labelFor(id),
    source: "pinned" as const,
  }));

const fetchCatalog = async (
  provider: LlmProvider,
  headers: Record<string, string>,
): Promise<ModelOption[]> => {
  const res = await fetch(provider.catalogUrl, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // The URL is a constant, so a redirect can only ever move us OFF the host
    // we meant to talk to — and undici does not strip a custom auth header
    // like Anthropic's `x-api-key` the way it strips `Authorization`. Refusing
    // outright is free here and removes the question entirely.
    redirect: "error",
  });
  // The provider's error body can carry account details; never let it travel.
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  const parsed = provider.parseCatalog(await res.json());
  const models: ModelOption[] = [];
  for (const { id, label } of parsed) {
    if (!provider.isSelectable(id)) continue;
    models.push({ id, label: label ?? provider.labelFor(id), source: "live" });
    if (models.length >= MAX_MODELS) break;
  }
  if (models.length === 0) throw new Error("catalog fetch returned no models");
  return models;
};

/** Single-flighted per provider, so N concurrent callers make one request. */
const refresh = (
  provider: LlmProvider,
  key: CacheKey,
  headers: Record<string, string>,
): Promise<void> => {
  const existing = inflight.get(key);
  if (existing) return existing.promise;
  const flight: Flight = { promise: Promise.resolve() };
  flight.promise = (async () => {
    try {
      const models = await fetchCatalog(provider, headers);
      cache.set(key, { models, fetchedAt: Date.now() });
    } catch {
      // Keep serving what we have, and pace the next attempt.
      //
      // The backoff is recorded even when there is NOTHING cached, which is
      // the case that matters most: cold is the state after every restart, and
      // the permanent state for a self-host with no egress or a revoked key.
      // Without an entry to hang `nextRetryAt` on, every request would take
      // the cold path and block for the full fetch timeout, forever. So a
      // failure seeds the pinned list as the entry — `fetchedAt: 0` keeps it
      // permanently stale, so a later success still replaces it.
      const entry = cache.get(key) ?? {
        models: pinned(provider),
        fetchedAt: 0,
      };
      entry.staleSince ??= Date.now();
      entry.nextRetryAt = Date.now() + RETRY_BACKOFF_MS;
      cache.set(key, entry);
    } finally {
      // Only if it is still OURS. `resetModelCatalogCache` clears `inflight`
      // mid-flight, and an old flight deleting a newer one's entry would let a
      // third caller start a duplicate fetch.
      if (inflight.get(key) === flight) inflight.delete(key);
    }
  })();
  inflight.set(key, flight);
  return flight.promise;
};

export interface ModelCatalog {
  models: ModelOption[];
  /**
   * True whenever these are not a fresh live list — pinned, or live but stale.
   * Callers use it to loosen id validation rather than refuse an edit during a
   * provider outage.
   */
  degraded: boolean;
}

/**
 * `credential` is a THUNK, not a value, and that is load-bearing rather than
 * stylistic: obtaining it costs a KMS decrypt per call in cloud, and this
 * endpoint is read by two components on every visit to an agent page. Passing
 * the plaintext eagerly would spend that quota — which is account-wide, shared
 * with every tenant's real secret traffic — to produce a value that a warm
 * cache immediately discards. Deferring it means the common path decrypts
 * nothing at all.
 */
export const getModelCatalog = async (
  provider: LlmProvider,
  secretId: string,
  credential: () => Promise<string | null>,
  authMode: "api-key" | "oauth",
): Promise<ModelCatalog> => {
  const key = `${provider.id}:${secretId}`;
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < TTL_MS)
    return { models: entry.models, degraded: false };

  // Decided BEFORE the credential is fetched, because it does not depend on
  // the value — and an OAuth secret DOES have a decryptable blob, so asking
  // first would spend a KMS decrypt on a credential we then refuse to use.
  const serveWhatWeHave = (): ModelCatalog => ({
    models: entry ? entry.models : pinned(provider),
    degraded: true,
  });
  if (!provider.canList(authMode)) return serveWhatWeHave();

  // A stale entry inside its backoff window answers now; no credential, no
  // fetch. Checked here so a failing provider costs nothing per request.
  if (entry?.nextRetryAt && Date.now() < entry.nextRetryAt)
    return serveWhatWeHave();

  const value = await credential();
  if (value === null) return serveWhatWeHave();
  const headers = provider.catalogHeaders(value);

  if (entry) {
    // Stale-while-revalidate: answer now from what we hold, refresh behind it,
    // so this endpoint's latency never tracks the provider's.
    void refresh(provider, key, headers);
    return { models: entry.models, degraded: true };
  }

  await refresh(provider, key, headers);
  const filled = cache.get(key);
  if (!filled) return { models: pinned(provider), degraded: true };
  // Freshness, not mere existence: a FAILED cold refresh also leaves an entry
  // (the pinned list, stamped `fetchedAt: 0` so it is stale by construction),
  // and reporting that as a live catalog would be a lie the UI acts on.
  return {
    models: filled.models,
    degraded: Date.now() - filled.fetchedAt >= TTL_MS,
  };
};
