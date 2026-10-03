import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * The object-storage arm, against a COMMAND-LEVEL fake client (no network,
 * no credentials): what it sends, what it signs into a presigned URL, and
 * how it delegates legacy inline rows to the Postgres arm.
 */

const pg = vi.hoisted(() => ({
  get: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("../../services/attachments/pg-blob-store", () => ({
  pgAttachmentBlobStore: { get: pg.get, expire: pg.expire },
}));

vi.mock("../../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/env")>()),
  ATTACHMENTS_S3_BUCKET: "onecli-attachments-test",
}));

const {
  attachmentObjectKey,
  hasAttachmentBucketConfigured,
  initS3ClientForTests,
  s3AttachmentBlobStore,
  ATTACHMENT_PRESIGN_TTL_SECONDS,
} = await import("./s3-blob-store");

/** Records every command; answers GetObject with fixed bytes. */
const fakeClient = () => {
  const sent: unknown[] = [];
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
  });
  vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
    sent.push(command);
    if (command instanceof GetObjectCommand) {
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array([1, 2, 3]),
        },
      };
    }
    return {};
  });
  return { client, sent };
};

const { initEntitlementForTests } = await import("../../lib/entitlements");

let sent: unknown[];

beforeEach(() => {
  // The store gates on the license at the bucket; these tests are about
  // what a LICENSED store does (the lock suite covers the refusal).
  initEntitlementForTests(true);
  pg.get.mockReset();
  pg.expire.mockReset();
  const fake = fakeClient();
  sent = fake.sent;
  initS3ClientForTests(fake.client);
});

afterEach(() => {
  initEntitlementForTests(null);
  vi.useRealTimers();
});

describe("s3AttachmentBlobStore", () => {
  it("is selected only when a bucket is configured", () => {
    expect(hasAttachmentBucketConfigured()).toBe(true);
  });

  it("keys objects by ids alone (never a file name) and returns an s3: storageRef", async () => {
    const meta = { id: "att-1", conversationId: "cv-1" };
    expect(attachmentObjectKey(meta)).toBe("attachments/cv-1/att-1");
    const result = await s3AttachmentBlobStore.put(meta, Buffer.from("hello"));
    expect(result).toEqual({ storageRef: "s3:attachments/cv-1/att-1" });
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: "onecli-attachments-test",
      Key: "attachments/cv-1/att-1",
      ContentLength: 5,
      ContentType: "application/octet-stream",
    });
  });

  it("get(): an s3: ref reads the object; an inline ref (legacy row) delegates to the Postgres arm", async () => {
    const bytes = await s3AttachmentBlobStore.get({
      id: "att-1",
      storageRef: "s3:attachments/cv-1/att-1",
    });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect((sent[0] as GetObjectCommand).input).toMatchObject({
      Key: "attachments/cv-1/att-1",
    });

    pg.get.mockResolvedValueOnce(Buffer.from("inline"));
    const legacy = await s3AttachmentBlobStore.get({
      id: "att-0",
      storageRef: null,
    });
    expect(legacy.toString()).toBe("inline");
    expect(pg.get).toHaveBeenCalledWith({ id: "att-0", storageRef: null });
    expect(sent).toHaveLength(1); // no S3 call for the inline row
  });

  it("presign(): a 5-minute GET whose SIGNATURE pins attachment disposition, the stored type and no-store", async () => {
    // A frozen clock: the TTL is exact arithmetic on it, not a race between
    // this line's Date.now() and the store's (which cost one CI run a 1 ms
    // tick past the bound).
    const now = new Date("2026-09-14T12:00:00.000Z");
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const signed = await s3AttachmentBlobStore.presign(
      { id: "att-1", storageRef: "s3:attachments/cv-1/att-1" },
      { name: "clip <1>.webm", mimeType: "video/webm" },
    );
    expect(signed).not.toBeNull();
    const url = new URL(signed!.url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toMatch(/onecli-attachments-test/);
    expect(url.pathname).toBe("/attachments/cv-1/att-1");
    // The response overrides ride the query AND are covered by the
    // signature (X-Amz-SignedHeaders is for headers; query params are part
    // of the canonical request), so a holder cannot strip them.
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="clip <1>.webm"; filename*=UTF-8''clip%20%3C1%3E.webm`,
    );
    expect(url.searchParams.get("response-content-type")).toBe("video/webm");
    expect(url.searchParams.get("response-cache-control")).toBe(
      "private, no-store",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe(
      String(ATTACHMENT_PRESIGN_TTL_SECONDS),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The signature's own date stamp rides the same frozen clock.
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260914T120000Z");
    expect(signed!.expiresAt.toISOString()).toBe(
      new Date(
        now.getTime() + ATTACHMENT_PRESIGN_TTL_SECONDS * 1000,
      ).toISOString(),
    );
  });

  it("presign(): a hostile name cannot break out of the disposition's quoted-string", async () => {
    // Quote and backslash are the two quoted-string escapes; a name carrying
    // them (past the upstream sanitizer or not) must still yield one header
    // with one filename parameter — no injected `; filename=` or CRLF.
    const signed = await s3AttachmentBlobStore.presign(
      { id: "att-2", storageRef: "s3:attachments/cv-1/att-2" },
      { name: 'a"; filename="evil.html\\', mimeType: "text/plain" },
    );
    const disposition = new URL(signed!.url).searchParams.get(
      "response-content-disposition",
    )!;
    expect(disposition).toBe(
      `attachment; filename="a'; filename='evil.html'"; filename*=UTF-8''a%22%3B%20filename%3D%22evil.html%5C`,
    );
    expect(disposition).not.toMatch(/[\\\r\n]/);
    expect(disposition.match(/filename=/g)).toHaveLength(2); // the pair, not a third
  });

  it("presign(): an inline (legacy) row has no URL — the api streams it", async () => {
    expect(
      await s3AttachmentBlobStore.presign(
        { id: "att-0", storageRef: null },
        { name: "a.txt", mimeType: "text/plain" },
      ),
    ).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("expire(): nulls inline rows through the Postgres arm AND deletes objects, batched at 1000, quiet", async () => {
    const refs = [
      { id: "in-1", storageRef: null },
      ...Array.from({ length: 1001 }, (_, i) => ({
        id: `o${i}`,
        storageRef: `s3:attachments/cv/o${i}`,
      })),
    ];
    await s3AttachmentBlobStore.expire(refs);
    expect(pg.expire).toHaveBeenCalledWith(refs);
    const deletes = sent.filter((c) => c instanceof DeleteObjectsCommand);
    expect(deletes).toHaveLength(2);
    const first = (deletes[0] as DeleteObjectsCommand).input;
    expect(first.Delete?.Objects).toHaveLength(1000);
    expect(first.Delete?.Quiet).toBe(true);
    expect((deletes[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: "attachments/cv/o1000" },
    ]);
  });

  it("expire(): a per-key failure inside a 200 DeleteObjects answer is LOUD — the sweep must not mark rows expired over bytes still in the bucket", async () => {
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    });
    vi.spyOn(client, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectsCommand) {
        return {
          Errors: [
            { Key: "attachments/cv/o1", Code: "AccessDenied", Message: "no" },
          ],
        };
      }
      return {};
    });
    initS3ClientForTests(client);
    await expect(
      s3AttachmentBlobStore.expire([
        { id: "o0", storageRef: "s3:attachments/cv/o0" },
        { id: "o1", storageRef: "s3:attachments/cv/o1" },
      ]),
    ).rejects.toThrow(
      /delete failed for 1 key\(s\): AccessDenied on attachments\/cv\/o1/,
    );
  });

  it("delete(): removes objects only (rows are the caller's); inline refs are ignored", async () => {
    await s3AttachmentBlobStore.delete([
      { id: "in-1", storageRef: null },
      { id: "o1", storageRef: "s3:attachments/cv/o1" },
    ]);
    expect(pg.expire).not.toHaveBeenCalled();
    const del = sent[0] as DeleteObjectsCommand;
    expect(del.input.Delete?.Objects).toEqual([{ Key: "attachments/cv/o1" }]);
  });

  it("an unknown storageRef scheme is refused loudly, never read as inline", async () => {
    await expect(
      s3AttachmentBlobStore.get({ id: "x", storageRef: "gcs:something" }),
    ).rejects.toThrow(/scheme not served/);
  });

  it("UNLICENSED: a write is refused with the license message; a legacy inline read still works (the free arm)", async () => {
    initEntitlementForTests(false);
    await expect(
      s3AttachmentBlobStore.put(
        { id: "att-1", conversationId: "cv-1" },
        Buffer.from("x"),
      ),
    ).rejects.toThrow(/license|Enterprise/i);
    expect(sent).toHaveLength(0);
    pg.get.mockResolvedValueOnce(Buffer.from("inline"));
    expect(
      (
        await s3AttachmentBlobStore.get({ id: "att-0", storageRef: null })
      ).toString(),
    ).toBe("inline");
  });
});
