import { getCrypto } from "../../providers";

/**
 * In-process decrypt cache + concurrency bound for the adapter config feed.
 *
 * Cloud crypto is a KMS call per credential, and the feed decrypts every
 * served presence whenever the etag busts — on an actively mirroring install
 * that used to be every few seconds, for the whole fleet, per instance. The
 * cache is keyed by CIPHERTEXT, so the mapping is immutable and invalidation
 * is structural: rotation produces a new ciphertext (a new key) and old
 * entries age out of the LRU bound.
 *
 * Security posture: no new exposure class. The same plaintext already leaves
 * the server on every config 200 and lives indefinitely in adapter memory;
 * this only widens plaintext residency inside a process that already holds
 * decrypt rights.
 */

const MAX_ENTRIES = 1000;
const MAX_CONCURRENT_DECRYPTS = 8;
/** Plaintext residency bound: on a small install nothing ever evicts by
 * count, so without a TTL a rotated-away credential's plaintext would sit in
 * heap for the process lifetime. An hour keeps the KMS savings (one decrypt
 * per credential per hour, not per etag bust) while giving revoked material
 * a bounded afterlife. */
const ENTRY_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  plaintext: string;
  at: number;
}

/** Map iteration order is insertion order — re-inserting on hit makes the
 * eviction (delete the first key) LRU without a dependency. */
const cache = new Map<string, CacheEntry>();

let running = 0;
const waiters: (() => void)[] = [];

const acquire = async (): Promise<void> => {
  if (running < MAX_CONCURRENT_DECRYPTS) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  running += 1;
};

const release = (): void => {
  running -= 1;
  waiters.shift()?.();
};

const freshHit = (ciphertext: string): string | undefined => {
  const hit = cache.get(ciphertext);
  if (hit === undefined) return undefined;
  if (Date.now() - hit.at > ENTRY_TTL_MS) {
    cache.delete(ciphertext);
    return undefined;
  }
  return hit.plaintext;
};

export const decryptCached = async (ciphertext: string): Promise<string> => {
  const hit = freshHit(ciphertext);
  if (hit !== undefined) {
    const entry = cache.get(ciphertext);
    if (entry) {
      cache.delete(ciphertext);
      cache.set(ciphertext, entry);
    }
    return hit;
  }
  await acquire();
  try {
    // A concurrent miss for the same ciphertext may have landed while this
    // caller waited on the semaphore.
    const won = freshHit(ciphertext);
    if (won !== undefined) return won;
    const plaintext = await getCrypto().decrypt(ciphertext);
    cache.set(ciphertext, { plaintext, at: Date.now() });
    if (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return plaintext;
  } finally {
    release();
  }
};

/** Tests swap crypto providers between suites; a stale mapping from another
 * provider's ciphertext space must not leak across. */
export const resetDecryptCacheForTests = (): void => {
  cache.clear();
};
