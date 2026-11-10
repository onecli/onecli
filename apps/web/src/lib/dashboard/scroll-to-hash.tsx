"use client";

import { useEffect } from "react";

/**
 * Keeps a `#<id>` landing on its block while the page fills in. The merged
 * agent pages (Knowledge, Settings, Contacts) render their blocks at once
 * but each block's content arrives later, so the browser's own hash scroll
 * fires while the target is still near the top, and the content loading
 * above it then pushes it out of view. This re-scrolls on every size change of the
 * target's container for a few seconds, and stops the moment the user
 * scrolls, so it never fights them. Renders nothing.
 */
export const ScrollToHash = () => {
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    const follow = () => {
      cleanup?.();
      cleanup = null;
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      const container = target?.parentElement;
      if (!target || !container || typeof ResizeObserver === "undefined") {
        return;
      }
      const scroll = () => target.scrollIntoView({ block: "start" });
      const observer = new ResizeObserver(scroll);
      const stop = () => {
        observer.disconnect();
        clearTimeout(timer);
        window.removeEventListener("wheel", stop);
        window.removeEventListener("touchmove", stop);
        window.removeEventListener("keydown", stop);
      };
      const timer = setTimeout(stop, 4000);
      window.addEventListener("wheel", stop, { passive: true });
      window.addEventListener("touchmove", stop, { passive: true });
      window.addEventListener("keydown", stop);
      observer.observe(container);
      scroll();
      cleanup = stop;
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
      cleanup?.();
    };
  }, []);
  return null;
};
