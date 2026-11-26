"use client";

import { useEffect } from "react";

/** Session flag that stops the chunk-error reload from looping. */
const RELOADED_KEY = "chunk-error-reloaded";

/**
 * Recovers an error boundary from a ChunkLoadError: after a deploy, cached
 * HTML may reference old JS chunks that no longer exist, and a single reload
 * fetches the new HTML with the right chunk references. The session flag
 * allows only one automatic reload; the next ChunkLoadError clears it
 * instead, so a later deploy can reload again.
 */
export const useChunkErrorReload = (error: Error) => {
  useEffect(() => {
    if (
      error.name === "ChunkLoadError" ||
      error.message?.includes("ChunkLoadError")
    ) {
      const alreadyReloaded = sessionStorage.getItem(RELOADED_KEY);

      if (!alreadyReloaded) {
        sessionStorage.setItem(RELOADED_KEY, "1");
        window.location.reload();
        return;
      }

      sessionStorage.removeItem(RELOADED_KEY);
    }
  }, [error]);
};

/** Clears the flag before a manual retry, so it gets a fresh reload. */
export const clearChunkErrorReload = () => {
  sessionStorage.removeItem(RELOADED_KEY);
};
