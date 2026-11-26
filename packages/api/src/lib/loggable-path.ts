/**
 * A request path safe to log. Agent webhook URLs (`/v1/hooks/<token>`) carry
 * their credential in the path, so the token never reaches a log line. The
 * api-server's legacy `/api/*` alias rewrites onto `/v1/*`, but the request
 * logger sees the ORIGINAL path, so both spellings are redacted.
 */
const HOOK_PATH = /^(\/(?:v1|api)\/hooks\/).+/;

export const loggablePath = (path: string): string =>
  path.replace(HOOK_PATH, "$1[redacted]");
