/**
 * Opens a centered, *blank* popup (the app-connect sizing) synchronously inside
 * a click — to be pointed at the install URL once the create resolves. Opening
 * it blank up front is the only way `window.open` survives a popup blocker: the
 * events-arm create round-trips through Slack's `apps.manifest.create`, so
 * `onSuccess` fires long after the click's transient activation is gone.
 * Returns `null` when the browser blocked it even here — the caller then offers
 * the URL as a plain link, whose click is a fresh gesture the blocker allows.
 *
 * Shared by the agent's own Slack card and the org Channels page's one-click
 * list, so both doors open the same window the same way.
 */
export const openInstallPopup = (): Window | null => {
  const w = 520;
  const h = 700;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  return window.open(
    "",
    "_blank",
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
  );
};
