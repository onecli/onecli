"use client";

import { useSyncExternalStore } from "react";

/** What a mounted dock tells the header's Computer button, and how the
 * button opens it. */
export interface MountedDock {
  /** The live card is on screen, so the header needs no second opener. */
  cardShowing: boolean;
  /** Restore the card, or open the theater (an ask, or no room for the
   * card). */
  show: () => void;
}

/**
 * Which agents have a dock mounted right now, and how to open it. The dock
 * lives inside the chat while its opener (the header's Computer button)
 * lives in the agent page header, a different subtree: the dock registers
 * here while mounted, and the button asks. Off the Chat section nothing is
 * registered, so the button links to the full-page Computer instead.
 */
const docks = new Map<string, MountedDock>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const registerDock = (
  agentId: string,
  dock: MountedDock,
): (() => void) => {
  docks.set(agentId, dock);
  notify();
  return () => {
    if (docks.get(agentId) !== dock) return;
    docks.delete(agentId);
    notify();
  };
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The mounted dock for this agent, or null when the chat isn't showing. */
export const useMountedDock = (agentId: string): MountedDock | null =>
  useSyncExternalStore(
    subscribe,
    () => docks.get(agentId) ?? null,
    () => null,
  );
