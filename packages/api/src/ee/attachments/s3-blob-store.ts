import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  AttachmentBlobMeta,
  AttachmentBlobRef,
  AttachmentBlobStore,
} from "../../providers/attachment-store";
import { pgAttachmentBlobStore } from "../../services/attachments/pg-blob-store";
import { ATTACHMENTS_S3_BUCKET } from "../../lib/env";
import { assertEntitled } from "../../lib/entitlements-guard";
import { attachmentDownloadDisposition } from "@onecli/agent-protocol";

/**
 * The object-storage arm of the attachment blob store (plans/agent-owns-its-
 * machine.md, Tier 3 follow-through). Metadata stays the Postgres row; the
 * BYTES go to a dedicated bucket, and downloads become short-lived presigned
 * URLs so the api leaves the byte path entirely — the two properties the
 * inline-Postgres arm cannot have at scale (a 25 MB `bytea` per send_file
 * against a bounded database allowance; one pooled connection and one in-process
 * buffer per download).
 *
 * Selected by `ensureEditionDefaults()` when the deployment is ENTITLED and
 * `ATTACHMENTS_S3_BUCKET` is set — config presence beats edition, and the
 * entitlement keeps an unlicensed self-host on Postgres even with the env set
 * (the "flag off ⇒ no EE behavior" posture). Per-row dispatch: a row with
 * `storageRef` null was written inline before the cutover (or by an
 * unlicensed sibling) and keeps reading from Postgres through the pg arm,
 * so enabling this needs no migration and mixed rows coexist forever.
 *
 * Trust: the key is derived from ids the control plane minted (never a file
 * name); the presigned GET pins `Content-Disposition: attachment` and the
 * stored media type in the SIGNATURE (response-* overrides), so a stored
 * SVG/HTML cannot be coaxed into rendering inline from the bucket by anyone
 * holding the URL. The bucket itself should block public access, require
 * TLS, and encrypt by default — no per-request key handling here.
 */

const STORAGE_REF_PREFIX = "s3:";
/** Long enough for a slow click, short enough that a leaked URL is stale. */
export const ATTACHMENT_PRESIGN_TTL_SECONDS = 300;

export const hasAttachmentBucketConfigured = (): boolean =>
  ATTACHMENTS_S3_BUCKET.length > 0;

let client: S3Client | null = null;
const s3 = (): S3Client => (client ??= new S3Client({}));

/** Test seam: swap the client (a command-level fake), or reset to real. */
export const initS3ClientForTests = (fake: S3Client | null): void => {
  client = fake;
};

/**
 * The bucket, behind the LICENSE gate. `ensureEditionDefaults()` only installs
 * this store when entitled, but the gate lives here too so no wiring mistake
 * can ever put bytes in object storage unlicensed (the enterprise-lock suite
 * probes exactly this). Reads of legacy inline rows never reach it.
 */
const bucket = (): string => {
  assertEntitled("attachments_s3");
  if (!ATTACHMENTS_S3_BUCKET) {
    throw new Error("ATTACHMENTS_S3_BUCKET is not configured");
  }
  return ATTACHMENTS_S3_BUCKET;
};

/** The object key for a row. Ids only — a file name never becomes a key. */
export const attachmentObjectKey = (meta: AttachmentBlobMeta): string =>
  `attachments/${meta.conversationId}/${meta.id}`;

/**
 * The object key behind a ref: `s3:<key>` → key; `null` (inline) → null so
 * the caller delegates to the Postgres arm. Any OTHER scheme is a ref this
 * deployment cannot serve (bytes written by a backend it does not run) —
 * loud, never read as inline and never guessed.
 */
const keyOf = (ref: AttachmentBlobRef): string | null => {
  if (ref.storageRef === null) return null;
  if (ref.storageRef.startsWith(STORAGE_REF_PREFIX)) {
    return ref.storageRef.slice(STORAGE_REF_PREFIX.length);
  }
  throw new Error(
    `attachment ${ref.id}: storageRef scheme not served by the S3 store`,
  );
};

const isObjectRef = (ref: AttachmentBlobRef): boolean =>
  ref.storageRef?.startsWith(STORAGE_REF_PREFIX) === true;

export const s3AttachmentBlobStore: AttachmentBlobStore = {
  async put(meta, bytes) {
    const key = attachmentObjectKey(meta);
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        // The stored type is advisory for S3 itself; the presigned GET pins
        // the response headers regardless (see presign).
        ContentType: "application/octet-stream",
      }),
    );
    return { storageRef: `${STORAGE_REF_PREFIX}${key}` };
  },

  async get(ref) {
    const key = keyOf(ref);
    // A legacy inline row: the pg arm owns it.
    if (key === null) return pgAttachmentBlobStore.get(ref);
    const out = await s3().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
    if (!out.Body) throw new Error(`attachment ${ref.id}: empty S3 object`);
    return Buffer.from(await out.Body.transformToByteArray());
  },

  async presign(ref, file) {
    const key = keyOf(ref);
    if (key === null) return null; // inline row: the api streams it
    const expiresAt = new Date(
      Date.now() + ATTACHMENT_PRESIGN_TTL_SECONDS * 1000,
    );
    const url = await getSignedUrl(
      s3(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        // Signed into the URL: the browser cannot strip them.
        ResponseContentDisposition: attachmentDownloadDisposition(file.name),
        ResponseContentType: file.mimeType,
        ResponseCacheControl: "private, no-store",
      }),
      { expiresIn: ATTACHMENT_PRESIGN_TTL_SECONDS },
    );
    return { url, expiresAt };
  },

  async expire(refs) {
    // Inline rows: the pg arm nulls their column. Object rows: delete.
    await pgAttachmentBlobStore.expire(refs);
    await deleteObjects(refs);
  },

  async delete(refs) {
    await deleteObjects(refs);
  },
};

/** DeleteObjects in batches of 1000 (the API's ceiling); idempotent (a
 * missing key is a success). Refs of another scheme are skipped here (a
 * sweep must not abort on one odd row); the READ path is where an unknown
 * scheme is loud. A PARTIAL failure is loud: DeleteObjects answers 200 with
 * per-key `Errors` (quiet mode reports only those), and swallowing them
 * would let the caller mark rows expired while their bytes still sit in
 * the bucket — the sweep must fail so those rows stay bound and retry. */
const deleteObjects = async (refs: AttachmentBlobRef[]): Promise<void> => {
  const keys = refs
    .filter(isObjectRef)
    .map(keyOf)
    .filter((key): key is string => key !== null);
  for (let i = 0; i < keys.length; i += 1000) {
    const out = await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: {
          Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    const failed = out.Errors ?? [];
    if (failed.length > 0) {
      const first = failed[0]!;
      throw new Error(
        `attachment object delete failed for ${failed.length} key(s): ${first.Code ?? "?"} on ${first.Key ?? "?"}`,
      );
    }
  }
};
