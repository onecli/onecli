import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCrypto } from "../../providers";
import {
  decryptCached,
  resetDecryptCacheForTests,
} from "./channel-decrypt-cache";

/**
 * The decrypt cache + concurrency bound, hermetic: crypto is injected through
 * the provider seam (`initCrypto`; null in afterEach resets the edition
 * default), so every "decrypt" here is a scripted fake and no KMS or key
 * material is involved. The module holds process-level state — the cache is
 * cleared between tests via `resetDecryptCacheForTests()`, and every test
 * drains its own decrypts so the semaphore's counters never leak forward.
 */

/** The module's own constants, pinned here so a drift fails a test rather
 * than silently reshaping the bound. */
const MAX_ENTRIES = 1000;
const MAX_CONCURRENT_DECRYPTS = 8;
const ENTRY_TTL_MS = 60 * 60 * 1000;

/** A fixed number of event-loop turns — lets parked semaphore waiters run. */
const settle = async (turns = 20): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

beforeEach(() => {
  resetDecryptCacheForTests();
});

afterEach(() => {
  initCrypto(null);
  vi.useRealTimers();
});

describe("the concurrency bound", () => {
  it("caps in-flight decrypts at 8 and still completes all 12", async () => {
    // 12 distinct ciphertexts land at once (an etag bust decrypting a whole
    // fleet): 8 slots fill, 4 callers park on the semaphore, and every freed
    // slot admits exactly one waiter — the ceiling never moves.
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: (() => void)[] = [];
    initCrypto({
      encrypt: async (plaintext) => plaintext,
      decrypt: (ciphertext) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          gates.push(() => {
            inFlight -= 1;
            resolve(`plain:${ciphertext}`);
          });
        });
      },
    });

    const results = Promise.all(
      Array.from({ length: 12 }, (_, i) => decryptCached(`ct-${i}`)),
    );
    await settle();
    expect(inFlight).toBe(MAX_CONCURRENT_DECRYPTS);

    // Release one at a time until every decrypt (waiters included) resolved.
    while (gates.length > 0) {
      gates.shift()?.();
      await settle();
    }
    expect(await results).toEqual(
      Array.from({ length: 12 }, (_, i) => `plain:ct-${i}`),
    );
    expect(maxInFlight).toBe(MAX_CONCURRENT_DECRYPTS);
  });

  it("a rejecting decrypt frees its slot and is NOT cached", async () => {
    // Fill ALL 8 slots with failures: if a throw leaked its slot, the pool
    // would be empty and the fresh decrypt below would park forever (the
    // test would time out). And a failure must never cache — the retry has
    // to reach the real decrypt again, not replay the error's absence.
    const calls: string[] = [];
    let failing = true;
    initCrypto({
      encrypt: async (plaintext) => plaintext,
      decrypt: async (ciphertext) => {
        calls.push(ciphertext);
        if (failing) throw new Error("kms unavailable");
        return `plain:${ciphertext}`;
      },
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        expect(decryptCached(`bad-${i}`)).rejects.toThrow("kms unavailable"),
      ),
    );

    failing = false;
    // Every slot came back: a fresh decrypt runs…
    expect(await decryptCached("good")).toBe("plain:good");
    // …and the failed ciphertext was never cached — the retry decrypts anew.
    expect(await decryptCached("bad-0")).toBe("plain:bad-0");
    expect(calls.filter((ciphertext) => ciphertext === "bad-0")).toHaveLength(
      2,
    );
  });
});

describe("the cache", () => {
  it("serves a repeat ciphertext from cache — one underlying decrypt", async () => {
    let decrypts = 0;
    initCrypto({
      encrypt: async (plaintext) => plaintext,
      decrypt: async (ciphertext) => {
        decrypts += 1;
        return `plain:${ciphertext}`;
      },
    });

    expect(await decryptCached("ct")).toBe("plain:ct");
    expect(await decryptCached("ct")).toBe("plain:ct");
    expect(decrypts).toBe(1);
  });

  it("evicts the least-recently-used entry past the bound, keeping a touched one", async () => {
    // Map iteration order is the LRU: a hit re-inserts, eviction deletes the
    // first key. Fill to the 1000-entry bound, touch the FIRST-inserted
    // entry (ct-0 moves to the back; ct-1 becomes the LRU), then insert the
    // 1001st: ct-1 is evicted while the touched ct-0 stays cached.
    const decrypts = new Map<string, number>();
    initCrypto({
      encrypt: async (plaintext) => plaintext,
      decrypt: async (ciphertext) => {
        decrypts.set(ciphertext, (decrypts.get(ciphertext) ?? 0) + 1);
        return `plain:${ciphertext}`;
      },
    });

    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      await decryptCached(`ct-${i}`);
    }
    await decryptCached("ct-0"); // the touch — re-inserted at the back
    await decryptCached(`ct-${MAX_ENTRIES}`); // 1001st entry → evict the LRU

    expect(await decryptCached("ct-0")).toBe("plain:ct-0");
    expect(decrypts.get("ct-0")).toBe(1); // still cached — the touch saved it
    expect(await decryptCached("ct-1")).toBe("plain:ct-1");
    expect(decrypts.get("ct-1")).toBe(2); // evicted — decrypted again
  });

  it("re-decrypts an entry older than the TTL — plaintext residency is bounded", async () => {
    // Only Date is faked (the fakes-side pattern): the cache holds no timers,
    // and real setImmediate keeps the semaphore paths live. The TTL runs from
    // the DECRYPT, not the last hit — a hit re-inserts the same entry with
    // its original stamp, so rotated-away material cannot live forever on
    // cache traffic alone.
    vi.useFakeTimers({ toFake: ["Date"] });
    let decrypts = 0;
    initCrypto({
      encrypt: async (plaintext) => plaintext,
      decrypt: async (ciphertext) => {
        decrypts += 1;
        return `plain:${ciphertext}`;
      },
    });

    expect(await decryptCached("ct")).toBe("plain:ct");
    // Just inside the hour: still a hit.
    vi.setSystemTime(Date.now() + ENTRY_TTL_MS - 60 * 1000);
    expect(await decryptCached("ct")).toBe("plain:ct");
    expect(decrypts).toBe(1);
    // Past the hour (measured from the decrypt — the hit refreshed nothing).
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(await decryptCached("ct")).toBe("plain:ct");
    expect(decrypts).toBe(2);
  });
});
