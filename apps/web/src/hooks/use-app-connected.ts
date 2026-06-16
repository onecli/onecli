"use client";

import { useEffect, useRef } from "react";

export interface AppConnectedEvent {
  provider?: string;
}

interface UseAppMessagesOptions {
  onConnected: (event: AppConnectedEvent) => void;
  onConfigure?: (provider: string) => void;
}

/**
 * Listens for `postMessage` events from the app-connect popup.
 * Dispatches to `onConnected` or `onConfigure` based on message type.
 *
 * Handlers are read through refs so the `message` listener is attached once for
 * the component's lifetime, instead of re-subscribing on every render when
 * callers pass inline (non-memoized) callbacks.
 */
export const useAppMessages = ({
  onConnected,
  onConfigure,
}: UseAppMessagesOptions) => {
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);
  const onConfigureRef = useRef(onConfigure);
  useEffect(() => {
    onConfigureRef.current = onConfigure;
  }, [onConfigure]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "app-connected") {
        onConnectedRef.current({
          provider: event.data.provider as string | undefined,
        });
      }
      if (event.data?.type === "app-configure" && event.data?.provider) {
        onConfigureRef.current?.(event.data.provider as string);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);
};
