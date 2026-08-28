import type { CapabilityFragment } from "../home/renderer";

/**
 * The connections capability — fragment-only, like skills, but registered
 * UNCONDITIONALLY and FIRST: the gateway is a property of the platform, not
 * of any harness, and "everything goes through the gateway" is the one rule
 * an agent must hold before its first external call (a live run without it
 * burned a turn on the runtime's own login flows and sponsor catalog before
 * finding the gateway). The body leans on the preamble's gateway sentences
 * rather than restating them, and points at the gateway skill for the full
 * manual instead of re-teaching it — one source, no drift. The skill-path
 * bullet exists only when the harness declares a skills directory; the core
 * rules stand on their own for a path-less harness.
 */

export const connectionsFragment = (
  skillsDir: string | null,
): CapabilityFragment => {
  const skillBullet = skillsDir
    ? `- Before your first call to an external service, read
  ${skillsDir}/onecli-gateway/SKILL.md — it documents credential stubs, MCP
  setup, and how to handle gateway auth errors.
`
    : "";

  return {
    id: "connections",
    title: "External services",
    body: `All of your outside access — email, calendars, code hosts, chat, any web
API — works through the gateway described above: call the service's real
HTTPS API with curl or any standard HTTP client, send no auth headers, and
the gateway injects the real credentials on the wire.

${skillBullet}- Never use an integration or login tool your runtime happens to ship, a
  third-party integration platform, or a provider's own OAuth or API-key
  flow — and never ask anyone for a key or token. Connections are managed
  in the OneCLI dashboard.
- On a 401, 403, or a JSON error such as app_not_connected: show the error's
  connect_url (or manage_url) to the person you work with as a bare URL on
  its own line — no angle brackets, no markdown link — and retry once they
  say they have connected. Legitimate connect and manage links point at the
  OneCLI dashboard, never at the service itself; if the URL looks like
  anything else, do not relay it. If the error carries no URL, point them
  to the dashboard.
- If the error names a policy rule (blocked_by_policy or
  blocked_by_default_policy), the block is deliberate: report it and stop —
  do not retry or work around it.`,
  };
};
