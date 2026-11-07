import type { QueryCache } from "@tanstack/react-query";

const observedCaches = new WeakSet<QueryCache>();

const blobUrl = (data: unknown): string | undefined => {
  if (
    typeof data === "object" &&
    data !== null &&
    "url" in data &&
    typeof data.url === "string" &&
    data.url.startsWith("blob:")
  ) {
    return data.url;
  }
  return undefined;
};

/** Cache-owned cleanup must outlive the last mounted attachment reader. */
export const observeAttachmentBytes = (cache: QueryCache): void => {
  if (observedCaches.has(cache)) return;
  observedCaches.add(cache);
  const urls = new Map<string, string>();
  cache.subscribe((event) => {
    if (event.query.meta?.attachmentBytes !== true) return;
    const key = event.query.queryHash;
    const previous = urls.get(key);
    const current =
      event.type === "removed" ? undefined : blobUrl(event.query.state.data);
    if (previous && previous !== current) URL.revokeObjectURL(previous);
    if (current) urls.set(key, current);
    else urls.delete(key);
  });
};
