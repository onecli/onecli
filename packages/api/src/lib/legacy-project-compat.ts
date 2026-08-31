import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "../types";
import { logger } from "./logger";

/**
 * Legacy project→workspace wire compatibility.
 *
 * The tenancy rename (project→workspace) changed the public wire: the
 * `X-Project-Id` header, the `?_project` query bridge, the `/v1/projects`
 * resource, the `scope: "project"` literal in policy-rule bodies, and the
 * `projectId` fields old clients read. Released CLIs (≤ 2.11.0) and SDKs
 * (≤ 3.1.0) still speak the old wire; this file keeps them working for a
 * deprecation window so a server upgrade never strands old clients.
 *
 * Two invariants, load-bearing for multitenancy:
 * - ABSENCE-ONLY: a canonical input (`x-workspace-id`, `?_workspace`,
 *   `scope: "workspace"`) always wins; legacy input is only read when no
 *   canonical form is present and can never override one.
 * - SAME FENCES: an aliased value enters the exact code path the canonical
 *   value would — org-key workspaces are still validated against the key's
 *   organization, session workspaces against the user's memberships. This
 *   file resolves nothing itself and never touches the database.
 *
 * Every legacy hit is answered with `Deprecation`/`Link` response headers and
 * one structured `logger.warn({ deprecatedSurface })` PER SURFACE (a request
 * combining the legacy header and the legacy path counts on both) — the
 * sunset criterion is those log counts going quiet.
 *
 * TEMPORARY — delete this file (and its test) at sunset, then revert the
 * call sites, all greppable by this file's name:
 * - `app.ts`: the `installLegacyProjectCompat(app)` line
 * - `validations/policy.ts`: delete its local `legacyResourceScope` const
 *   (kept there, zod-only, because that schema reaches a client bundle) and
 *   restore the plain `z.enum(["organization", "workspace"])` on two fields
 * - `routes/auth-session.ts`: unwrap `withLegacyProjectId(...)`
 * - `routes/cli-auth.ts`: unwrap `withLegacyProjectLists(...)`
 * - `apps/api-server/src/app.ts`: drop `LEGACY_PROJECT_HEADER` from CORS
 * - `middleware/auth.ts` (2 sites): strip the "(formerly X-Project-Id)"
 *   hint from the error messages (and their pinned tests)
 * - and the sibling gateway module `apps/gateway/crates/common/src/compat.rs`
 */

/** Exported for the api-server CORS allow-list (browser callers preflight it). */
export const LEGACY_PROJECT_HEADER = "X-Project-Id";

const DEPRECATION_LINK =
  '<https://onecli.sh/docs/api-reference>; rel="deprecation"';

type LegacySurface = "x-project-id" | "_project" | "/v1/projects";

/** Logged at DETECTION time, so a request whose handler later throws still
 * counts toward the sunset metric. */
const warnLegacySurface = (surface: LegacySurface) => {
  logger.warn(
    { deprecatedSurface: surface },
    "legacy project-era wire surface used; migrate the client before sunset",
  );
};

const setLegacyResponseHeaders = (res: Response) => {
  try {
    res.headers.set("Deprecation", "true");
    res.headers.set("Link", DEPRECATION_LINK);
  } catch {
    // An immutable-header response (unlikely on our own routes) must never
    // turn a working legacy request into a 500.
  }
};

/**
 * Bridge `X-Project-Id` / `?_project` into `x-workspace-id` when — and only
 * when — no canonical scope input is present. Reassigns `c.req.raw` (a header
 * clone of the same request, body preserved) so EVERY downstream reader sees
 * the bridged header: the auth middleware's own query bridge, the API-key and
 * session resolvers, and `invalidateGatewayCache(c.req.raw)`.
 */
const legacyScopeMiddleware = createMiddleware<ApiEnv>(async (c, next) => {
  let surface: LegacySurface | null = null;

  // An empty value counts as absent — mirrors the API-key resolver (a falsy
  // `x-workspace-id` is "missing-workspace") and the gateway's header filter.
  const hasCanonical =
    Boolean(c.req.raw.headers.get("x-workspace-id")) ||
    Boolean(c.req.query("_workspace"));

  if (!hasCanonical) {
    const legacyHeader = c.req.raw.headers.get("x-project-id");
    const legacyValue = legacyHeader || c.req.query("_project");
    if (legacyValue) {
      try {
        const headers = new Headers(c.req.raw.headers);
        headers.set("x-workspace-id", legacyValue);
        // Clone from the request itself (not just the URL) so the method and
        // body ride along — route handlers read the body through `c.req.raw`.
        c.req.raw = new Request(c.req.raw, { headers });
        surface = legacyHeader ? "x-project-id" : "_project";
        warnLegacySurface(surface);
      } catch {
        // A value that isn't a valid Latin-1 header makes Headers.set throw;
        // degrade to "no legacy input" rather than surfacing a 500 — auth then
        // resolves as if the legacy param were absent (same posture as the
        // auth middleware's own query bridge).
      }
    }
  }

  await next();

  if (surface) setLegacyResponseHeaders(c.res);
});

/**
 * Install the compat layer on the shared app. Must run BEFORE the route
 * mounts in `createApiApp` so the middleware precedes every handler.
 */
export const installLegacyProjectCompat = (app: Hono<ApiEnv>) => {
  app.use("*", legacyScopeMiddleware);

  // `/v1/projects*` → `/v1/workspaces*`, re-dispatched through the SAME app so
  // `onError`/`notFound` and the EE `/:workspaceId/access` routes (composed
  // onto `/workspaces` from the EE block) all apply — a detached router would
  // lose the shared error handler. No recursion: the rewritten path can never
  // match `/projects` again. Responses stay byte-canonical (`workspaceId`
  // fields); only the path is aliased.
  const forwardToWorkspaces = async (c: Context<ApiEnv>) => {
    const url = new URL(c.req.url);
    const rewritten = url.pathname.replace(
      /^\/v1\/projects(?=\/|$)/,
      "/v1/workspaces",
    );
    // The no-recursion guarantee rests on the rewrite actually changing the
    // path; if the app's basePath ever diverges from /v1 a no-op rewrite
    // would re-dispatch the same URL forever. Fail as a 404 instead.
    if (rewritten === url.pathname) return c.notFound();
    url.pathname = rewritten;
    warnLegacySurface("/v1/projects");
    const res = await app.fetch(new Request(url, c.req.raw), c.env);
    setLegacyResponseHeaders(res);
    return res;
  };
  // `/*` does not cover the collection root — register both, like the 410
  // shims in `removed-routes.ts`.
  app.all("/projects", forwardToWorkspaces);
  app.all("/projects/*", forwardToWorkspaces);
};

/** Dual-emit `projectId` beside `workspaceId` for old readers of a response. */
export const withLegacyProjectId = <T extends object>(
  payload: T,
): T & { projectId?: string } => {
  // Constraint is `object` (with runtime narrowing) because one call site
  // spreads a hook payload typed Record<string, unknown> — a `workspaceId`
  // property constraint would trip the weak-type check there.
  if ("workspaceId" in payload && typeof payload.workspaceId === "string") {
    return { ...payload, projectId: payload.workspaceId };
  }
  return payload;
};

/** Dual-emit each org's `workspaces` list under the legacy `projects` key. */
export const withLegacyProjectLists = <T extends { workspaces: unknown }>(
  organizations: T[],
): (T & { projects: T["workspaces"] })[] =>
  organizations.map((org) => ({ ...org, projects: org.workspaces }));
