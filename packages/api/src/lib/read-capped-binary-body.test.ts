import { describe, expect, it } from "vitest";
import { readCappedBinaryBody } from "./read-capped-binary-body";

/** Build a carrier with a streamed body — the exact shape a Hono Request's
 * `.raw` presents (a web Request with a ReadableStream body). */
const carrier = (
  chunks: Uint8Array[],
  contentLength?: number,
): { headers: Headers; body: ReadableStream<Uint8Array> | null } => ({
  headers: new Headers(
    contentLength === undefined
      ? {}
      : { "content-length": String(contentLength) },
  ),
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
});

describe("readCappedBinaryBody", () => {
  it("returns the concatenated bytes under the cap", async () => {
    const result = await readCappedBinaryBody(
      carrier([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]),
      100,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect([...result.bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses at the Content-Length gate — a declared oversize is a cheap 413", async () => {
    // A truthful oversize Content-Length is refused without draining the
    // whole body (the reader is never acquired).
    const result = await readCappedBinaryBody(
      carrier([new Uint8Array(200)], 999),
      100,
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses MID-STREAM when a lying/absent Content-Length lets bytes through", async () => {
    // No content-length header: the gate is skipped, so the running count is
    // the real cap. Ten 20-byte chunks past a 100-byte cap must stop early.
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(20));
    const result = await readCappedBinaryBody(carrier(chunks), 100);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("treats a zero-length body as empty", async () => {
    const result = await readCappedBinaryBody(carrier([]), 100);
    expect(result).toEqual({ ok: false, reason: "empty" });
  });

  it("treats a missing body as empty", async () => {
    const result = await readCappedBinaryBody(
      { headers: new Headers(), body: null },
      100,
    );
    expect(result).toEqual({ ok: false, reason: "empty" });
  });
});
