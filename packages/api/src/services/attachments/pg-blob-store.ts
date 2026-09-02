import { db } from "@onecli/db";
import type {
  AttachmentBlobRef,
  AttachmentBlobStore,
} from "../../providers/attachment-store";

/**
 * The inline-Postgres arm of the attachment blob store — the default in BOTH
 * editions today: self-host's api container has no writable disk besides
 * Postgres, and cloud's hosted plane is dark until its runner substrate
 * lands. Bytes live in the metadata row's `data` column (`storageRef` null),
 * size-capped at every door, so the row cascade is the whole deletion story.
 *
 * Injected by `ensureEditionDefaults()` — never imported by the providers
 * barrel (this module rides the DB client; the barrel is client-reachable).
 */
export const pgAttachmentBlobStore: AttachmentBlobStore = {
  async put(meta, bytes) {
    await db.conversationAttachment.update({
      where: { id: meta.id },
      // Prisma 6 Bytes wants Uint8Array<ArrayBuffer>; the copy also detaches
      // the stored value from whatever pooled buffer the reader used.
      data: { data: new Uint8Array(bytes), storageRef: null },
    });
    return { storageRef: null };
  },

  async get(ref: AttachmentBlobRef) {
    if (ref.storageRef !== null) {
      // Bytes written by an external backend (S3) this deployment is not
      // running — loud beats a silent empty file in the sandbox.
      throw new Error(
        `attachment ${ref.id}: bytes live in an external store (` +
          `storageRef set) but only the Postgres store is configured`,
      );
    }
    const row = await db.conversationAttachment.findUnique({
      where: { id: ref.id },
      select: { data: true },
    });
    if (!row?.data) {
      throw new Error(`attachment ${ref.id}: no stored bytes`);
    }
    return Buffer.from(row.data);
  },

  async delete() {
    // Inline bytes die with their rows — the FK cascade owns it.
  },
};
