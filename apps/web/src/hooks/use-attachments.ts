"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { attachments } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import type { AttachmentMeta } from "@/lib/api/types";

/**
 * Attachment bytes for chip previews, as an object URL.
 *
 * Cached per attachment (`staleTime: Infinity` — the bytes are immutable) and
 * REVOKED when the cache entry is dropped: `gcTime` is finite and the query
 * cache's removal event releases the URL, so a long chat session cannot leak
 * one blob per image seen (App Router client navigation never unloads the
 * document, so the browser would not reclaim them on its own).
 */
const BLOB_GC_MS = 10 * 60 * 1000;

export const useAttachmentBlobUrl = (
  conversationId: string,
  attachmentId: string,
  enabled: boolean,
) => {
  const qc = useQueryClient();
  const key = queryKeys.attachments.blob(conversationId, attachmentId);

  useEffect(() => {
    // One subscription for the whole cache: when an attachment-blob entry is
    // removed, revoke the URL it held.
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "removed") return;
      const removedKey = event.query.queryKey;
      if (removedKey[0] !== "attachments" || removedKey[2] !== "blob") return;
      const url = event.query.state.data;
      if (typeof url === "string" && url.startsWith("blob:")) {
        URL.revokeObjectURL(url);
      }
    });
    return unsubscribe;
  }, [qc]);

  return useQuery({
    queryKey: key,
    queryFn: async () =>
      URL.createObjectURL(
        await attachments.fetchAttachmentBlob(conversationId, attachmentId),
      ),
    enabled: enabled && conversationId.length > 0 && attachmentId.length > 0,
    staleTime: Infinity,
    gcTime: BLOB_GC_MS,
    retry: false,
  });
};

/** Stage one file for a message — the composer's injected upload. */
export const useUploadAttachment = (conversationId: string) =>
  useMutation({
    mutationFn: (file: File) =>
      attachments.uploadAttachment(conversationId, file),
  });

/**
 * Save an attachment to disk. An ANCHOR with `download`, never a navigation:
 * opening the bytes as a document would run an `image/svg+xml` payload's
 * script in this origin. The blob is re-typed `application/octet-stream` for
 * the same reason (belt for the raster allowlist upstream).
 */
export const useDownloadAttachment = (conversationId: string) =>
  useMutation({
    mutationFn: async (attachment: AttachmentMeta) => {
      const blob = await attachments.fetchAttachmentBlob(
        conversationId,
        attachment.id,
      );
      const url = URL.createObjectURL(
        new Blob([blob], { type: "application/octet-stream" }),
      );
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
      } finally {
        // The click consumed the URL synchronously.
        URL.revokeObjectURL(url);
      }
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Download failed"),
  });
