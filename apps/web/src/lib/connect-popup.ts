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

/** Returns the popup handle — `null` means a blocker ate it and no
 * `app-connected` message will ever arrive, so callers can release any
 * claim they staked on it. */
export const openConnectPopup = (
  provider: string,
  options?: ConnectPopupOptions,
): WindowProxy | null => {
  const w = 520;
  const h = options?.height ?? 700;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  const params = new URLSearchParams();
  if (options?.agentName) params.set("agent_name", options.agentName);
  if (options?.connectionId) params.set("connectionId", options.connectionId);
  if (options?.workspaceId) params.set("workspaceId", options.workspaceId);
  if (options?.orgId) params.set("orgId", options.orgId);
  const qs = params.toString();
  return window.open(
    `/app-connect/${encodeURIComponent(provider)}${qs ? `?${qs}` : ""}`,
    `connect-${provider}-${options?.connectionId ?? "new"}`,
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
  );
};
