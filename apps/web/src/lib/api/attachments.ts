import { apiUpload, apiFetch } from "@/lib/api-fetch";
import { ApiError } from "./client";
import { conversationPath } from "./conversations";
import type { AttachmentMeta } from "./types";

/**
 * Attachment upload/read — raw binary, so neither call rides the JSON
 * client: `apiPost` stringifies its body and `apiFetch` pins a JSON
 * Content-Type. Metadata comes back as ordinary JSON; bytes come back as a
 * Blob the caller turns into an object URL.
 */

/**
 * The house error envelope is `{ error: { message, type } }` for every
 * ServiceError-mapped refusal, and a bare `{ error: "…" }` for the handful of
 * routes that answer directly (the upload's 413). Read BOTH — stringifying
 * the object rendered every refusal as "[object Object]".
 */
const refused = async (res: Response): Promise<ApiError> => {
  const body: unknown = await res.json().catch(() => ({}));
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
  const message =
    typeof err === "string"
      ? err
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : `Request failed: ${res.status}`;
  return new ApiError(message, res.status);
};

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
  if (!res.ok) throw await refused(res);
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
  if (!res.ok) throw await refused(res);
  return res.blob();
};
