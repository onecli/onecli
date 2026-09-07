/**
 * Read a request body as BYTES with a hard cap enforced mid-stream.
 *
 * The existing text-capped reader (channel-inbound-slack's `readCappedBody`)
 * buffers the WHOLE body before checking and UTF-8-decodes it — fine for a
 * 1MB JSON webhook, unusable for binary uploads: the decode corrupts bytes
 * and a hostile chunked body (no Content-Length) would be fully buffered
 * before any cap applied. This reader streams: the Content-Length gate is
 * the cheap first refusal, and the running count cancels the stream the
 * moment it passes the cap.
 */

export type CappedBinaryBody =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "too_large" | "empty" | "unreadable" };

/** Both `Request` and `Response` qualify — the reader only needs these. */
interface BinaryBodyCarrier {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export const readCappedBinaryBody = async (
  raw: BinaryBodyCarrier,
  maxBytes: number,
): Promise<CappedBinaryBody> => {
  const declared = Number(raw.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const body = raw.body;
  if (!body) return { ok: false, reason: "empty" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  if (total === 0) return { ok: false, reason: "empty" };
  return { ok: true, bytes: Buffer.concat(chunks) };
};
