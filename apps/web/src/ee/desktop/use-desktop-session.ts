"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import type { DesktopState } from "./api";
import { useReleaseControl, useTakeControl } from "./use-desktop";
import type { DesktopViewHandle, DesktopViewStatus } from "./desktop-view";

/**
 * The takeover session's client logic, once: take, stop, the stream's status, the focus hand-off onto the canvas,
 * and the words the toasts say. Both theater hosts (the in-app overlay and
 * the theater page) drive the same `DesktopScreen` + `DesktopControlPill`
 * pair through this, so neither carries a copy.
 */
export const useDesktopSession = (agentId: string, agentName: string) => {
  const take = useTakeControl(agentId);
  const release = useReleaseControl(agentId);
  const [status, setStatus] = useState<DesktopViewStatus>("connecting");
  const view = useRef<DesktopViewHandle>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  // Esc on the captured canvas: noVNC swallows every key there, Tab
  // included, so Esc is the way out. It lands on Stop, one press from
  // handing back, and never hands back by itself.
  const focusStop = useCallback(() => stopButton.current?.focus(), []);

  const onTake = useCallback(() => {
    take.mutate(undefined, {
      onSuccess: () => {
        // Keystrokes go to the screen from the first one: the focus ring
        // tells the person so.
        requestAnimationFrame(() => view.current?.focus());
      },
      onError: (err) => {
        toast.error(
          err instanceof ApiError && err.status === 409
            ? err.message
            : "Couldn’t take control. Try again.",
        );
      },
    });
  }, [take]);

  const onStop = useCallback(() => {
    release.mutate(undefined, {
      onSuccess: () => toast.success(`${agentName} is back on it.`),
      onError: () => toast.error("Couldn’t stop. Try again."),
    });
  }, [agentName, release]);

  return {
    status,
    setStatus,
    view,
    stopButton,
    focusStop,
    onTake,
    onStop,
    taking: take.isPending,
    stopping: release.isPending,
  };
};

export type DesktopSession = ReturnType<typeof useDesktopSession>;

/** Whether the viewer drives: the lease is theirs and the control host is
 * in hand. Everything else is watching. */
export const isDriving = (state: DesktopState): boolean =>
  state.you.controlling && state.controlHost !== null;
