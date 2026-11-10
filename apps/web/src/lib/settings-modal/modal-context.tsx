"use client";

import { createContext, useContext } from "react";
import type { SettingsPageId } from "./pages";

/**
 * What a component rendered inside the Settings modal knows about its
 * frame: the page it is on, and the scope the slot resolved. Null on a
 * route page. The connections components ask this to keep their links
 * inside the modal (`useConnectionsHref`) and to scope a connect popup to
 * the org when the URL beneath names only a workspace.
 */
interface SettingsModalFrame {
  page: SettingsPageId;
  organizationId: string;
  workspaceId?: string;
}

const SettingsModalContext = createContext<SettingsModalFrame | null>(null);

export const SettingsModalProvider = SettingsModalContext.Provider;

export const useSettingsModal = (): SettingsModalFrame | null =>
  useContext(SettingsModalContext);
