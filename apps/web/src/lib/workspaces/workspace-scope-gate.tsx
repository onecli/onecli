"use client";

import { useLayoutEffect, useState } from "react";
import { getWorkspaceId } from "@/lib/api-fetch";

/**
 * Holds a workspace's pages back until the browser's URL is that
 * workspace's. Every URL-scoped read (`queryKeys`' scope, `apiFetch`'s
 * workspace header) takes the workspace from `window.location`, and on a
 * client-side switch into another workspace Next renders the new pages
 * before it writes the new URL (it does so as that render commits). Read
 * then, the pages would key their reads to the workspace being left: its
 * cached agents, so the agent just opened is "not found", or the empty
 * agents page forwards to the previous workspace's agent, and nothing
 * re-renders them once the URL catches up.
 *
 * So the first render for a workspace the URL does not name yet draws
 * nothing, and a layout effect (after Next has written the URL, before the
 * browser paints) draws the pages, now reading the right workspace. A
 * render with the URL already right (every other navigation, a reload)
 * passes straight through. If the URL somehow never matches, the pages
 * draw anyway after that one render rather than leave a blank page.
 */
export const WorkspaceScopeGate = ({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) => {
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const inScope = settledFor === workspaceId || urlNamesWorkspace(workspaceId);
  useLayoutEffect(() => {
    if (!inScope) setSettledFor(workspaceId);
  }, [inScope, workspaceId]);
  return inScope ? children : null;
};

/** On the server there is no URL to lag behind: always in scope. */
const urlNamesWorkspace = (workspaceId: string): boolean => {
  if (typeof window === "undefined") return true;
  const fromUrl = getWorkspaceId();
  return fromUrl !== undefined && decodeURIComponent(fromUrl) === workspaceId;
};
