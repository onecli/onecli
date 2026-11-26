import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The optimistic-write toolkit: what lets a switch, a chooser or a remove
 * button answer the click at once while the request runs behind it.
 *
 * The model (TanStack Query's "via the cache" optimistic updates, plus the
 * concurrent-mutation rules from TkDodo's "Concurrent Optimistic Updates"):
 *
 * 1. `onMutate` patches ONE item in every cached view of it (`patchItem`),
 *    first cancelling in-flight reads of those views so a refetch that
 *    started before the click can't land over the patch.
 * 2. `onError` runs the returned rollback, which puts back exactly that one
 *    item, and only while the item still holds what this write put there. A
 *    later click on the same item, or a refetch that already brought the
 *    truth, wins over the rollback. Two rows toggled together with one
 *    failing leave the other row alone.
 * 3. `onSuccess` may install the server's version of the item
 *    (`installItem`), but only when no later write to the same item is still
 *    queued (`queuedWrites`), or an older answer would repaint a newer click.
 * 4. The settle refetch runs once the LAST write of a family is done
 *    (`writeFamily`), so an early refetch never paints an in-flight row
 *    back to its old value.
 * 5. Writes to the SAME item run strictly in click order (`serializeWrite`):
 *    on → off → on must reach the server as three ordered writes, or a fast
 *    second request could overtake the first and leave the server "off".
 */

/** Undo one optimistic patch. */
export type Rollback = () => void;

/** Undo several patches, newest first. */
export const combineRollbacks =
  (...rollbacks: Rollback[]): Rollback =>
  () => {
    for (const rollback of [...rollbacks].reverse()) rollback();
  };

/**
 * How to read and write one item inside a cached value. `set` with
 * `undefined` removes the item; `original` (the value before the patch) lets
 * a list put a restored item back at its old position.
 */
export interface ItemLens<TData, TItem> {
  get: (data: TData) => TItem | undefined;
  set: (data: TData, item: TItem | undefined, original?: TData) => TData;
}

/** The lens for one element of a cached array, matched by `match`. Tolerates
 * a value that is not an array (it is left alone), so a surprising cache
 * entry can never make a click throw. */
export const listItem = <T>(match: (item: T) => boolean): ItemLens<T[], T> => ({
  get: (items) => (Array.isArray(items) ? items.find(match) : undefined),
  set: (items, item, original) => {
    if (!Array.isArray(items)) return items;
    const index = items.findIndex(match);
    if (item === undefined) {
      return index === -1 ? items : items.filter((_, i) => i !== index);
    }
    if (index !== -1) return items.map((x, i) => (i === index ? item : x));
    // Re-inserting (a rolled-back remove): back where it was, when known.
    const was = Array.isArray(original) ? original.findIndex(match) : -1;
    const at = was === -1 ? items.length : Math.min(was, items.length);
    return [...items.slice(0, at), item, ...items.slice(at)];
  },
});

/** A lens through a field of an object value (`{ crons: [...] }`). A value
 * under the same key prefix that has no such field (a detail entry nested
 * under a list's key) is left alone. */
export const throughField = <
  TData extends object,
  K extends keyof TData,
  TItem,
>(
  field: K,
  inner: ItemLens<TData[K], TItem>,
): ItemLens<TData, TItem> => {
  const holds = (data: unknown): data is TData =>
    typeof data === "object" && data !== null && field in data;
  return {
    get: (data) => (holds(data) ? inner.get(data[field]) : undefined),
    set: (data, item, original) => {
      if (!holds(data)) return data;
      const next = inner.set(
        data[field],
        item,
        holds(original) ? original[field] : undefined,
      );
      return next === data[field] ? data : { ...data, [field]: next };
    },
  };
};

/** A lens for a value that IS the item (a single-resource query). */
export const wholeValue = <T>(): ItemLens<T, T> => ({
  get: (data) => data,
  // A single-resource query can't "remove" its value; keep it.
  set: (data, item) => item ?? data,
});

/**
 * Patch one item in every cached query under `queryKey` (a prefix: a
 * namespace or one exact key) and return its rollback. A query with no data
 * yet is left alone: there is nothing on screen to keep in step, and a value
 * invented there would read as if the server had said it.
 *
 * Synchronous on purpose. Cancelling a read reverts its state at once (only
 * the settling of its promise is async), so the patch lands in the click's
 * own tick, and the write behind it is queued before any other task (a
 * response to an earlier write) can run in between.
 */
export const patchItem = <TData, TItem>(
  qc: QueryClient,
  queryKey: QueryKey,
  lens: ItemLens<TData, TItem>,
  next: (current: TItem | undefined) => TItem | undefined,
): Rollback => {
  void qc.cancelQueries({ queryKey });
  const rollbacks: Rollback[] = [];
  for (const [key, data] of qc.getQueriesData<TData>({ queryKey })) {
    if (data === undefined) continue;
    const before = lens.get(data);
    const after = next(before);
    if (after === before) continue;
    const stored = qc.setQueryData<TData>(key, lens.set(data, after));
    // What the cache actually holds: structural sharing may have copied
    // `after`, and later writes that leave this item alone keep THIS ref.
    const written = stored === undefined ? after : lens.get(stored);
    rollbacks.push(() => {
      const now = qc.getQueryData<TData>(key);
      // Only while the item still holds what this write put there.
      if (now === undefined || lens.get(now) !== written) return;
      qc.setQueryData<TData>(key, lens.set(now, before, data));
    });
  }
  return combineRollbacks(...rollbacks);
};

/** Write the server's version of one item into every cached view of it,
 * without cancelling reads (truth needs no protecting from truth). */
export const installItem = <TData, TItem>(
  qc: QueryClient,
  queryKey: QueryKey,
  lens: ItemLens<TData, TItem>,
  item: TItem | undefined,
): void => {
  for (const [key, data] of qc.getQueriesData<TData>({ queryKey })) {
    if (data === undefined) continue;
    const next = lens.set(data, item);
    if (next !== data) qc.setQueryData<TData>(key, next);
  }
};

interface FamilyState {
  inFlight: number;
  waiters: (() => void)[];
}

const families = new WeakMap<QueryClient, Map<string, FamilyState>>();

const familyState = (qc: QueryClient, family: string): FamilyState => {
  let byName = families.get(qc);
  if (!byName) {
    byName = new Map();
    families.set(qc, byName);
  }
  let state = byName.get(family);
  if (!state) {
    state = { inFlight: 0, waiters: [] };
    byName.set(family, state);
  }
  return state;
};

/**
 * A family of related writes (every grant write, every cron write…) that
 * refreshes the truth ONCE, after its last write settles. `begin` from
 * `onMutate`; return `settle(refresh)` from `onSettled`.
 *
 * The last write to settle runs `refresh`; every earlier one waits for that
 * refresh too. Since TanStack keeps a mutation pending until its `onSettled`
 * resolves, every write of a burst stays pending until the refetched truth
 * is on screen, which is what lets a row tell "my write is still settling"
 * (`useMutationState`) from "this is the server's answer".
 *
 * Counted here rather than with `isMutating`: a waiting write is still
 * pending there, so two writes settling together would each see the other
 * and wait forever.
 */
export const writeFamily = (qc: QueryClient, family: string) => ({
  begin: () => {
    familyState(qc, family).inFlight += 1;
  },
  settle: async (refresh: () => Promise<unknown>): Promise<void> => {
    const state = familyState(qc, family);
    state.inFlight -= 1;
    if (state.inFlight > 0) {
      return new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    const waiting = state.waiters;
    state.waiters = [];
    try {
      await refresh();
    } catch {
      // Never reject: TanStack treats a throwing onSettled as the WRITE
      // failing, which would roll back a write the server accepted. A failed
      // refetch keeps the last answer and the next read catches up.
    } finally {
      for (const resolve of waiting) resolve();
    }
  },
});

const queues = new Map<string, Promise<void>>();
const counts = new Map<string, number>();

/** How many writes to `key` are queued or running right now. A write's own
 * `onSuccess` already sees itself subtracted. */
export const queuedWrites = (key: string): number => counts.get(key) ?? 0;

/**
 * Run `write` after every earlier write queued under the same `key` has
 * settled (success or failure alike), so writes to one item reach the server
 * in the order they were clicked. Writes under different keys run in
 * parallel. Bookkeeping for a key is dropped once its last write settles.
 *
 * TanStack's mutation `scope` serializes too, but its id is fixed per hook
 * instance; this keys on the item itself (agent + connection, cron id…), so
 * every surface that writes the same item shares one queue.
 */
export const serializeWrite = <T>(
  key: string,
  write: () => Promise<T>,
): Promise<T> => {
  counts.set(key, queuedWrites(key) + 1);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(write).finally(() => {
    const left = queuedWrites(key) - 1;
    if (left > 0) counts.set(key, left);
    else counts.delete(key);
  });
  // What the NEXT write waits on: this one settling, never its outcome.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
};
