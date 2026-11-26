/**
 * The one `/app-connect/<provider>` OAuth popup opener every connect surface
 * shares (connections tabs, app detail, the chat's connect card) — the
 * geometry, feature string, and window naming stay identical so popups
 * dedupe against each other instead of stacking.
 *
 * The window name carries the connection id (or `"new"`), so re-authenticating
 * an existing connection never steals a fresh-connect popup for the same
 * provider, and vice versa. On success the popup posts
 * `{ type: "app-connected", provider, connectionId }` to its opener — listen
 * with `useAppMessages`.
 */

import type { AppDefinition } from "@onecli/api/apps/types";

export interface ConnectPopupOptions {
  /** Shown on the popup's success screen ("Go back to <agent>…"). */
  agentName?: string;
  /** The agent this connect starts from: a created (or re-added) account is
   * switched on for it, and only for it. Omitted = a workspace connect, which
   * switches it on for no agent. */
  agentId?: string;
  /** Re-authenticate this existing connection instead of creating one. */
  connectionId?: string;
  workspaceId?: string;
  orgId?: string;
  /** Popup height — credentials-import forms need the taller 820. */
  height?: number;
}

/** Credentials-import forms need the taller popup. */
export const connectPopupHeight = (
  app: Pick<AppDefinition, "connectionMethod">,
): number | undefined =>
  app.connectionMethod.type === "credentials_import" ? 820 : undefined;

/** GitHub's install and settings pages are desktop layouts (~1024px wide):
 * every popup that lands on them uses this, so none are cut off. Still
 * clamped to the screen by `openCenteredPopup`. */
export const GITHUB_POPUP = { height: 820, width: 1024 } as const;

/** A centered popup with the connect popup's geometry, for any URL (e.g. a
 * GitHub settings page). `null` = a blocker ate it. */
export const openCenteredPopup = (
  url: string,
  name: string,
  height = 700,
  width = 520,
): WindowProxy | null => {
  // Never wider/taller than the screen the opener is on (when it's known:
  // `availWidth`/`availHeight` read 0 in some embeds and in jsdom).
  const fit = (want: number, avail: number) =>
    avail > 0 ? Math.min(want, avail - 40) : want;
  const w = fit(width, window.screen.availWidth);
  const h = fit(height, window.screen.availHeight);
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(
    url,
    name,
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
  );
};

/** Returns the popup handle — `null` means a blocker ate it and no
 * `app-connected` message will ever arrive, so callers can release any
 * claim they staked on it. */
export const openConnectPopup = (
  provider: string,
  options?: ConnectPopupOptions,
): WindowProxy | null => {
  const params = new URLSearchParams();
  if (options?.agentName) params.set("agent_name", options.agentName);
  if (options?.agentId) params.set("agent_id", options.agentId);
  if (options?.connectionId) params.set("connectionId", options.connectionId);
  if (options?.workspaceId) params.set("workspaceId", options.workspaceId);
  if (options?.orgId) params.set("orgId", options.orgId);
  const qs = params.toString();
  // The GitHub App's install / Configure pages are desktop layouts. (The
  // OAuth "github" app's consent page fits the default size.)
  const github = provider === "github-app";
  return openCenteredPopup(
    `/app-connect/${encodeURIComponent(provider)}${qs ? `?${qs}` : ""}`,
    `connect-${provider}-${options?.connectionId ?? "new"}`,
    options?.height ?? (github ? GITHUB_POPUP.height : undefined),
    github ? GITHUB_POPUP.width : undefined,
  );
};
