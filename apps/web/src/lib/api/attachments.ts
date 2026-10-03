import { apiUpload, apiFetch } from "@/lib/api-fetch";
import { refusal } from "./client";
import { conversationPath } from "./conversations";
import type { AttachmentMeta, AttachmentPageMeta } from "./types";

/**
 * Attachment upload/read — raw binary, so neither call rides the JSON
 * client: `apiPost` stringifies its body and `apiFetch` pins a JSON
 * Content-Type. Metadata comes back as ordinary JSON; bytes come back as a
 * Blob the caller turns into an object URL.
 */

export const uploadAttachment = async (
  conversationId: string,
  file: File,
  signal?: AbortSignal,
): Promise<AttachmentMeta> => {
  const path = conversationPath(
    conversationId,
    `/attachments?name=${encodeURIComponent(file.name || "file")}`,
  );
  const res = await apiUpload(path, file, {
    contentType: file.type || "application/octet-stream",
    signal,
  });
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AttachmentMeta;
};

/** The bytes, authenticated — chip previews object-URL the returned blob. */
export const fetchAttachmentBlob = async (
  conversationId: string,
  attachmentId: string,
): Promise<Blob> => {
  const res = await apiFetch(
    conversationPath(
      conversationId,
      `/attachments/${encodeURIComponent(attachmentId)}`,
    ),
  );
  if (!res.ok) throw await refusal(res);
  return res.blob();
};

/** The row's metadata alone (name, type, size, caption) — what a download
 * page shows before it asks for the bytes. Same fence as the bytes. */
export const fetchAttachmentMeta = async (
  conversationId: string,
  attachmentId: string,
): Promise<AttachmentPageMeta> => {
  const res = await apiFetch(
    conversationPath(
      conversationId,
      `/attachments/${encodeURIComponent(attachmentId)}/meta`,
    ),
  );
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AttachmentPageMeta;
};

/**
 * Where the browser should download from. `{ url, expiresAt }` when the
 * backend mints presigned URLs (object storage); `null` when the bytes are
 * inline and the caller must stream them through `fetchAttachmentBlob`.
 */
export const fetchAttachmentDownloadUrl = async (
  conversationId: string,
  attachmentId: string,
): Promise<{ url: string; expiresAt: string } | null> => {
  const res = await apiFetch(
    conversationPath(
      conversationId,
      `/attachments/${encodeURIComponent(attachmentId)}/download-url`,
    ),
  );
  if (res.status === 204) return null;
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as { url: string; expiresAt: string };
};
