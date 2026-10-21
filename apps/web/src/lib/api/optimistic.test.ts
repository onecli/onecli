import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  installItem,
  listItem,
  patchItem,
  queuedWrites,
  serializeWrite,
  throughField,
  wholeValue,
} from "./optimistic";

interface Row {
  id: string;
  on: boolean;
}

const rows = listItem<Row>((r) => r.id === "b");
const key = ["rows", "org", "ws"] as const;

const seeded = () => {
  const qc = new QueryClient();
  qc.setQueryData<Row[]>(key, [
    { id: "a", on: false },
    { id: "b", on: false },
    { id: "c", on: false },
  ]);
  return qc;
};

/** A promise the test settles by hand. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("patchItem", () => {
  it("patches only the matched item, and its rollback restores only it", async () => {
    const qc = seeded();
    const rollback = await patchItem(qc, key, rows, (r) =>
      r ? { ...r, on: true } : r,
    );
    expect(qc.getQueryData<Row[]>(key)?.map((r) => r.on)).toEqual([
      false,
      true,
      false,
    ]);
    // Another row changes meanwhile (a second toggle): the rollback keeps it.
    qc.setQueryData<Row[]>(key, (old) =>
      old?.map((r) => (r.id === "a" ? { ...r, on: true } : r)),
    );
    rollback();
    expect(qc.getQueryData<Row[]>(key)?.map((r) => r.on)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("a rollback never clobbers a newer write to the same item", async () => {
    const qc = seeded();
    const first = await patchItem(qc, key, rows, (r) =>
      r ? { ...r, on: true } : r,
    );
    await patchItem(qc, key, rows, (r) => (r ? { ...r, on: false } : r));
    first();
    // The second click (off) stands; the first write's failure is moot.
    expect(qc.getQueryData<Row[]>(key)?.[1]?.on).toBe(false);
  });

  it("a rolled-back remove puts the row back where it was", async () => {
    const qc = seeded();
    const rollback = await patchItem(qc, key, rows, () => undefined);
    expect(qc.getQueryData<Row[]>(key)?.map((r) => r.id)).toEqual(["a", "c"]);
    rollback();
    expect(qc.getQueryData<Row[]>(key)?.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("leaves queries with no data alone (nothing on screen to patch)", async () => {
    const qc = new QueryClient();
    qc.getQueryCache().build(qc, { queryKey: key });
    await patchItem(qc, key, rows, () => ({ id: "b", on: true }));
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  it("patches every cached view under a prefix, through an object field", async () => {
    const qc = new QueryClient();
    const lens = throughField<{ rows: Row[] }, "rows", Row>("rows", rows);
    qc.setQueryData(["v", "1"], { rows: [{ id: "b", on: false }] });
    qc.setQueryData(["v", "2"], { rows: [{ id: "b", on: false }] });
    await patchItem(qc, ["v"], lens, (r) => (r ? { ...r, on: true } : r));
    expect(qc.getQueryData<{ rows: Row[] }>(["v", "1"])?.rows[0]?.on).toBe(
      true,
    );
    expect(qc.getQueryData<{ rows: Row[] }>(["v", "2"])?.rows[0]?.on).toBe(
      true,
    );
  });

  it("cancels an in-flight read so it can't land over the patch", async () => {
    const qc = seeded();
    const read = deferred<Row[]>();
    void qc.fetchQuery({ queryKey: key, queryFn: () => read.promise });
    await patchItem(qc, key, rows, (r) => (r ? { ...r, on: true } : r));
    // The stale read resolves late with the pre-click value.
    read.resolve([
      { id: "a", on: false },
      { id: "b", on: false },
      { id: "c", on: false },
    ]);
    await Promise.resolve();
    expect(qc.getQueryData<Row[]>(key)?.[1]?.on).toBe(true);
  });
});

describe("installItem", () => {
  it("writes the server's item into a single-resource query", () => {
    const qc = new QueryClient();
    qc.setQueryData(["one"], { id: "x", on: false });
    installItem(qc, ["one"], wholeValue<Row>(), { id: "x", on: true });
    expect(qc.getQueryData<Row>(["one"])?.on).toBe(true);
  });
});

describe("serializeWrite", () => {
  it("runs writes to one item in click order, even when the first is slow", async () => {
    const order: string[] = [];
    const slow = deferred<void>();
    const first = serializeWrite("item-1", async () => {
      await slow.promise;
      order.push("first");
    });
    const second = serializeWrite("item-1", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    slow.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("a failed write doesn't block the next one, and still rejects", async () => {
    const first = serializeWrite("item-2", () =>
      Promise.reject(new Error("boom")),
    );
    const second = serializeWrite("item-2", async () => "ok");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });

  it("writes to different items run in parallel", async () => {
    const gate = deferred<void>();
    const started: string[] = [];
    const a = serializeWrite("item-a", async () => {
      started.push("a");
      await gate.promise;
    });
    const b = serializeWrite("item-b", async () => {
      started.push("b");
    });
    await b;
    expect(started).toEqual(["a", "b"]);
    gate.resolve();
    await a;
  });

  it("counts what is still queued, so an older answer can tell it is stale", async () => {
    const gate = deferred<void>();
    let seenByFirst = -1;
    const first = serializeWrite("item-3", async () => {
      await gate.promise;
    }).then(() => {
      seenByFirst = queuedWrites("item-3");
    });
    const second = serializeWrite("item-3", async () => {});
    expect(queuedWrites("item-3")).toBe(2);
    gate.resolve();
    await first;
    // The first write's success sees the second still pending.
    expect(seenByFirst).toBe(1);
    await second;
    expect(queuedWrites("item-3")).toBe(0);
  });
});
