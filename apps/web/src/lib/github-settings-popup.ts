/**
 * The GitHub App installation's settings page (where a GitHub owner adds or
 * removes the repositories the app reaches), opened as a centered popup like
 * every other connect window. A blocked popup falls back to a new tab.
 */

/** Only ever open GitHub's own pages. */
export const isGitHubUrl = (url: unknown): url is string =>
  typeof url === "string" && url.startsWith("https://github.com/");

/** Returns false (and opens nothing) for anything that isn't a GitHub URL. */
export const openGitHubSettingsPopup = (url: unknown): boolean => {
  if (!isGitHubUrl(url)) return false;
  const w = 1024;
  const h = 760;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open(
    url,
    "github-installation-settings",
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes,resizable=yes`,
  );
  if (!popup) window.open(url, "_blank", "noopener,noreferrer");
  return true;
};
