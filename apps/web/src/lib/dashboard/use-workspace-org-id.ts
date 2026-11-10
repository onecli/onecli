"use client";

import { useSyncExternalStore } from "react";

/**
 * The org of the workspace on screen, as the workspace layout announces it
 * (`WorkspaceNameBroadcast` fires `onecli:workspace-context`). A workspace
 * URL names no org, so the sidebar learns it here.
 *
 * A module-level store, read through `useSyncExternalStore`: one window
 * listener for every reader, attached when the module loads in the
 * browser, so an announcement made before the sidebar mounts is still the
 * value it renders with.
 */
const EVENT = "onecli:workspace-context";

let current: string | null = null;
const subscribers = new Set<() => void>();

const onContext = (e: Event) => {
  if (!(e instanceof CustomEvent)) return;
  const detail: unknown = e.detail;
  if (
    typeof detail === "object" &&
    detail !== null &&
    "organizationId" in detail &&
    typeof detail.organizationId === "string" &&
    detail.organizationId !== current
  ) {
    current = detail.organizationId;
    for (const notify of subscribers) notify();
  }
};

if (typeof window !== "undefined") window.addEventListener(EVENT, onContext);

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
};

const getSnapshot = () => current;
const getServerSnapshot = () => null;

export const useWorkspaceOrgId = (): string | null =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
