"use client";

import { useEffect } from "react";

/**
 * Listens for `postMessage` events from the app-connect popup.
 * Calls `onConnected` when an app is successfully connected.
 */
export const useAppConnected = (onConnected: () => void) => {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "app-connected") {
        onConnected();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onConnected]);
};
