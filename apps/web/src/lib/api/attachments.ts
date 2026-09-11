import { apiUpload, apiFetch } from "@/lib/api-fetch";
import { refusal } from "./client";
import { conversationPath } from "./conversations";
import type { AttachmentMeta } from "./types";

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
