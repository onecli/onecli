"use client";

import { useAppMessages } from "@/hooks/use-app-connected";
import { useInvalidateGrants } from "@/hooks/use-grants";

export interface ReconnectWatcherProps {
  provider: string;
  /** Called once the popup reports this provider connected. */
  onDone: () => void;
}

/**
 * Mounted only while a row's reconnect popup is open, so a page of rows
 * holds no idle message listeners. When the popup reports back, the row and
 * every grant view of it refresh with the new credentials (and label).
 */
export const ReconnectWatcher = ({
  provider,
  onDone,
}: ReconnectWatcherProps) => {
  const invalidateGrants = useInvalidateGrants();
  useAppMessages({
    onConnected: (event) => {
      if (event.provider !== provider) return;
      invalidateGrants();
      onDone();
    },
  });
  return null;
};
