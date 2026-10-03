"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { attachments } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
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
/**
 * One attachment's metadata (the download page). Immutable once bound, so
 * cached indefinitely; a 404 is a settled answer (the fence said no, or the
 * row is gone), never retried — the page renders it as "not available".
 */
export const useAttachmentMeta = (
  conversationId: string,
  attachmentId: string,
) =>
  useQuery({
    queryKey: queryKeys.attachments.meta(conversationId, attachmentId),
    queryFn: () =>
      attachments.fetchAttachmentMeta(conversationId, attachmentId),
    enabled: conversationId.length > 0 && attachmentId.length > 0,
    staleTime: Infinity,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 2,
  });

export const useUploadAttachment = (conversationId: string) =>
  useMutation({
    mutationFn: (file: File) =>
      attachments.uploadAttachment(conversationId, file),
  });

/**
 * Save an attachment to disk.
 *
 * Two paths, chosen by the backend. When the api mints a presigned URL
 * (object storage), the browser downloads STRAIGHT from the bucket through
 * an anchor pointing at it: the api never touches the bytes, and the URL's
 * signature pins `Content-Disposition: attachment` plus the stored type, so
 * following it can only ever save a file — a stored SVG cannot render in any
 * origin. When the bytes are inline (204), the blob path below: an ANCHOR
 * with `download`, never a navigation (opening the bytes as a document would
 * run an `image/svg+xml` payload's script in THIS origin), and the blob
 * re-typed `application/octet-stream` as a belt for the raster allowlist
 * upstream.
 */
export const useDownloadAttachment = (conversationId: string) =>
  useMutation({
    mutationFn: async (attachment: AttachmentMeta) => {
      const signed = await attachments.fetchAttachmentDownloadUrl(
        conversationId,
        attachment.id,
      );
      if (signed) {
        const anchor = document.createElement("a");
        anchor.href = signed.url;
        // Cross-origin `download` is advisory; the signed disposition is
        // what makes the browser save rather than navigate.
        anchor.download = attachment.name;
        anchor.rel = "noopener";
        anchor.click();
        return;
      }
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
