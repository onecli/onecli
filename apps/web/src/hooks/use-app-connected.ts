"use client";

import { useEffect } from "react";

interface UseAppMessagesOptions {
  onConnected: () => void;
  onConfigure?: (url: string) => void;
}

/**
 * Listens for `postMessage` events from the app-connect popup.
 * Dispatches to `onConnected` or `onConfigure` based on message type.
 */
export const useAppMessages = ({
  onConnected,
  onConfigure,
}: UseAppMessagesOptions) => {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "app-connected") {
        onConnected();
      }
      if (event.data?.type === "app-configure" && event.data?.url) {
        onConfigure?.(event.data.url);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onConnected, onConfigure]);
};
