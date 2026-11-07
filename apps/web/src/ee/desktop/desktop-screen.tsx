"use client";

import { type Ref } from "react";
import { cn } from "@onecli/ui/lib/utils";
import type { DesktopState } from "./api";
import {
  DesktopPlaceholder,
  type DesktopPlaceholderProps,
} from "./desktop-placeholder";
import {
  DesktopView,
  type DesktopViewHandle,
  type DesktopViewStatus,
} from "./desktop-view";
import styles from "./desktop-transitions.module.css";

export const SCREEN_TRANSITION_NAME = "onecli-desktop-screen";

export interface DesktopScreenProps {
  state: DesktopState;
  viewOnly: boolean;
  quality?: number;
  onStatus?: (status: DesktopViewStatus) => void;
  onEscape?: () => void;
  className?: string;
  viewRef?: Ref<DesktopViewHandle>;
  children?: React.ReactNode;
}

/** A card always uses the watcher host, even when this person owns a lease. */
export const streamHostOf = (
  state: DesktopState,
  viewOnly = false,
): string | null =>
  state.available
    ? !viewOnly && state.you.controlling && state.controlHost
      ? state.controlHost
      : state.viewHost
    : null;

/** What stands in for a screen there is no stream for yet. */
const placeholderFor = (state: DesktopState): DesktopPlaceholderProps => {
  switch (state.sandboxState) {
    case "asleep":
      return {
        caption: "Asleep",
        detail:
          "Wake it to see the screen. The agent’s files and sign-ins are kept.",
        busy: false,
      };
    case "unviewable":
      return {
        caption: "Can’t show the screen",
        detail:
          "The agent’s screen didn’t come up. Restarting the agent usually helps.",
        busy: false,
      };
    default:
      return {
        caption: "Waking up…",
        detail:
          "The screen appears as soon as it’s up, usually within a minute.",
        busy: true,
      };
  }
};

/** Only the active screen is mounted. Its transition name is never duplicated. */
export const DesktopScreen = ({
  state,
  viewOnly,
  quality,
  onStatus,
  onEscape,
  className,
  viewRef,
  children,
}: DesktopScreenProps) => {
  const host = streamHostOf(state, viewOnly);
  return (
    <div
      className={cn(
        "bg-muted pointer-events-auto relative aspect-[16/10] overflow-hidden rounded-xl ring-1 ring-black/10 dark:ring-white/10",
        styles.screen,
        className,
      )}
      style={{ viewTransitionName: SCREEN_TRANSITION_NAME }}
    >
      {host ? (
        <DesktopView
          ref={viewRef}
          host={host}
          viewOnly={viewOnly}
          quality={quality}
          onStatus={onStatus}
          onEscape={onEscape}
          className="absolute inset-0"
        />
      ) : (
        <DesktopPlaceholder {...placeholderFor(state)} />
      )}
      {children}
    </div>
  );
};
