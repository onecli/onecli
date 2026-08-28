import { failMissingCloudDefault } from "./edition-state";

// ── Attachment blob store (edition default) ─────────────────────────────────
// Where conversation-attachment BYTES live. Metadata is always the
// `conversation_attachments` row; this seam owns only the payload, so a
// scalable backend (S3 on cloud) can replace the Postgres column without
// touching a single call site. Dispatch is per ROW, not per deployment:
// `storageRef` null = bytes inline in the row's `data` column; non-null = the
// key of whichever external store wrote it (the ciphertext-shape pattern —
// rows written by different backends coexist, so a cutover needs no
// migration).
//
// The Postgres implementation imports the DB client, which must never enter
// a browser bundle — so, like `newOrgPolicySeeder`, BOTH edition arms are
// injected by `ensureEditionDefaults()` and an uninjected read fails loudly
// in either edition. A future S3 arm is one impl + one edition-defaults line
// gated on config presence (bucket env set — config presence beats edition),
// and it lives OUTSIDE ee/ (attachments are free code).

/** Identity of the row the bytes belong to — enough for any backend to build
 * a deterministic key. */
export interface AttachmentBlobMeta {
  id: string;
  conversationId: string;
}

/** A stored blob's address: the row id plus its backend dispatch key. */
export interface AttachmentBlobRef {
  id: string;
  storageRef: string | null;
}

export interface AttachmentBlobStore {
  /**
   * Persist the bytes for an EXISTING metadata row. Returns the row's
   * `storageRef` (null = inline). Size caps are enforced at the doors before
   * this is ever called.
   */
  put(
    meta: AttachmentBlobMeta,
    bytes: Buffer,
  ): Promise<{
    storageRef: string | null;
  }>;
  /** Fetch the bytes. Throws (loudly) for a ref this backend cannot serve —
   * bytes written by an external store this deployment no longer runs. */
  get(ref: AttachmentBlobRef): Promise<Buffer>;
  /**
   * Best-effort payload cleanup for rows about to be (or already) deleted.
   * The Postgres arm is a no-op — the row cascade owns the bytes; an
   * external arm deletes its objects here and backstops with bucket
   * lifecycle (row cascades cannot reach external objects).
   */
  delete(refs: AttachmentBlobRef[]): Promise<void>;
}

let overrideStore: AttachmentBlobStore | null = null;
let defaultStore: AttachmentBlobStore | null = null;

/** Test seam. `null` resets to the injected edition default. */
export const initAttachmentStore = (s: AttachmentBlobStore | null): void => {
  overrideStore = s;
};

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultAttachmentStore = (s: AttachmentBlobStore): void => {
  defaultStore = s;
};

export const getAttachmentStore = (): AttachmentBlobStore =>
  overrideStore ?? defaultStore ?? failMissingCloudDefault("attachmentStore");
