"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DOCK_CORNERS, type DockCorner } from "./use-throwable";

export type DesktopDockMode = "card" | "chip";
export interface DesktopDockPrefs {
  mode: DesktopDockMode;
  chat: boolean;
  /** Where in the chat the card rests (thrown there by the person). */
  corner: DockCorner;
}

/** Every agent's computer starts minimized to the header's Computer button;
 * the person opens the card, and that choice is remembered per agent. */
export const DEFAULT_DOCK_PREFS: DesktopDockPrefs = {
  mode: "chip",
  chat: false,
  corner: "bottom-right",
};
export const DOCK_CARD_MIN_WIDTH = 1024;
const CARD_FITS_QUERY = `(min-width: ${DOCK_CARD_MIN_WIDTH}px)`;
const keyFor = (agentId: string) => `onecli:desktop-dock:${agentId}`;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
// Only failed writes live here. Normal preferences remain cross-tab storage.
const unsaved = new Map<string, DesktopDockPrefs>();
const cache = new Map<
  string,
  { raw: string | null; prefs: DesktopDockPrefs }
>();

const parse = (raw: string | null): DesktopDockPrefs => {
  if (!raw) return DEFAULT_DOCK_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_DOCK_PREFS;
    return {
      mode:
        "mode" in value && (value.mode === "chip" || value.mode === "card")
          ? value.mode
          : DEFAULT_DOCK_PREFS.mode,
      chat: "chat" in value && value.chat === true,
      corner:
        DOCK_CORNERS.find(
          (corner) => "corner" in value && value.corner === corner,
        ) ?? DEFAULT_DOCK_PREFS.corner,
    };
  } catch {
    return DEFAULT_DOCK_PREFS;
  }
};

const snapshot = (agentId: string): DesktopDockPrefs => {
  const pending = unsaved.get(agentId);
  if (pending) return pending;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyFor(agentId));
  } catch {
    // Disabled storage still permits in-memory preferences for this visit.
  }
  const hit = cache.get(agentId);
  if (hit && hit.raw === raw) return hit.prefs;
  const prefs = parse(raw);
  cache.set(agentId, { raw, prefs });
  return prefs;
};

const write = (agentId: string, prefs: DesktopDockPrefs) => {
  try {
    window.localStorage.setItem(keyFor(agentId), JSON.stringify(prefs));
    unsaved.delete(agentId);
  } catch {
    unsaved.set(agentId, prefs);
  }
  notify();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("onecli:desktop-dock:")) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

/** Per-agent preferences, with a stable server snapshot and storage fallback.
 * Starts minimized; an explicit choice survives viewport changes. */
export const useDesktopDockPrefs = (agentId: string) => {
  const prefs = useSyncExternalStore(
    subscribe,
    () => snapshot(agentId),
    () => DEFAULT_DOCK_PREFS,
  );
  const update = useCallback(
    (patch: Partial<DesktopDockPrefs>) =>
      write(agentId, { ...snapshot(agentId), ...patch }),
    [agentId],
  );
  return { prefs, update };
};

const subscribeCardFits = (listener: () => void) => {
  const mq = window.matchMedia(CARD_FITS_QUERY);
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
};

/** Below 1024px the card doesn't fit: the computer stays minimized and
 * opening it goes to the full page. Null until hydration completes. */
export const useCardFits = (): boolean | null =>
  useSyncExternalStore(
    subscribeCardFits,
    () => window.matchMedia(CARD_FITS_QUERY).matches,
    () => null,
  );
