import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { ServiceError } from "../services/errors";

/**
 * 410 Gone for the old-model endpoints step 10 removed.
 *
 * `/v1` is a versioned public surface with clients in the wild — `onecli rules`
 * in the CLI, the SDK, anything scripted against it — so these paths cannot just
 * stop existing and answer the router's generic "Unrecognized request URL". Each
 * one says what happened and where the capability went, which is what the
 * release before this one did for the same paths (it answered 410 once v2
 * editing went live).
 *
 * TEMPORARY, but on a different clock from the tables: these go when no
 * supported client still calls them (~one major version), NOT with
 * `policy-legacy-migration/`.
 *
 * Mounted AFTER the live routers in `app.ts`, so a surviving route on a shared
 * base path (`/agents`, `/connections`) always wins — Hono takes the first
 * match, and these only ever catch what no longer exists.
 */

/**
 * Where each scope's capability actually lives — and they now differ.
 *
 * Attach-model step 6 retired project-scope `/v1/policy/*` as well, so the old
 * single "Use /v1/policy" suffix would have pointed a project-scoped client at
 * another 410. Project callers are sent to the grants surface (the only project
 * writer); org callers keep the full rule set at `/v1/org/policy`.
 */
const PROJECT_REPLACEMENT =
  "Project access is granted per agent: PUT " +
  "/v1/agents/:agentId/grants/connections/:connectionId and " +
  "/v1/agents/:agentId/grants/secrets/:secretId.";

const ORG_REPLACEMENT =
  "Use /v1/org/policy — one first-match rule set covering blocks, allows, " +
  "rate limits, approvals and app permissions.";

const gone = (what: string): never => {
  throw new ServiceError("GONE", `${what} ${PROJECT_REPLACEMENT}`);
};

/** The org-scope twin of `gone` — same shape, org pointer. */
const goneOrg = (what: string): never => {
  throw new ServiceError("GONE", `${what} ${ORG_REPLACEMENT}`);
};

/** `/v1/rules/*` — the whole legacy rule CRUD, plus its two read helpers. */
export const removedRuleRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/overlap/:provider", () =>
    gone(
      "GET /v1/rules/overlap/:provider was removed: rule overlap is computed " +
        "by the organization Policy console.",
    ),
  );
  app.all("/permissions/:provider", () =>
    gone(
      "/v1/rules/permissions/:provider was removed: app permissions are policy " +
        "rules with an app target. Read the tool catalog from " +
        "/v1/apps/permission-definitions.",
    ),
  );
  app.all("/*", () => gone("/v1/rules was removed."));
  app.all("/", () => gone("/v1/rules was removed."));
  return app;
};

/** `/v1/org/rules/*` — the org-scope twin. */
export const removedOrgRuleRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/*", () => goneOrg("/v1/org/rules was removed."));
  app.all("/", () => goneOrg("/v1/org/rules was removed."));
  return app;
};

/** `/v1/org/settings` — carried only the org-wide `policyMode` toggle. */
export const removedOrgSettingsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/*", () =>
    goneOrg(
      "/v1/org/settings was removed: the allow/deny posture is the scope's " +
        "Default Rule.",
    ),
  );
  app.all("/", () =>
    goneOrg(
      "/v1/org/settings was removed: the allow/deny posture is the scope's " +
        "Default Rule.",
    ),
  );
  return app;
};

/** The per-agent equipment routes under `/v1/agents`. */
export const removedAgentEquipmentRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/granular-access", () =>
    gone(
      "GET /v1/agents/granular-access was removed: resource scoping rides the " +
        "granting rule's conditions.",
    ),
  );
  app.all("/:agentId/secrets", () =>
    gone(
      "/v1/agents/:agentId/secrets was removed: grant a secret with an allow " +
        "rule naming the agent and targeting the secret.",
    ),
  );
  app.all("/:agentId/connections", () =>
    gone(
      "/v1/agents/:agentId/connections was removed: grant a connection with an " +
        "allow rule naming the agent and targeting the connection.",
    ),
  );
  // Step 5 of the attach model: `secret_mode` is no longer writable — every
  // agent is selective and receives exactly what its grants attach. The CLI's
  // `onecli agents set-secret-mode` lands here until it is repointed.
  app.all("/:agentId/secret-mode", () =>
    gone(
      "PATCH /v1/agents/:agentId/secret-mode was removed: agents are always " +
        "selective now. Attach credentials with PUT " +
        "/v1/agents/:agentId/grants/connections/:connectionId or " +
        "/grants/secrets/:secretId instead.",
    ),
  );
  return app;
};

/**
 * Project-scope policy CRUD under `/v1/policy` — retired in attach-model step 6
 * so the project level has exactly one writer, the grants API.
 *
 * Every path is enumerated deliberately: `policyReflectRoutes` shares this base
 * and must keep serving `GET /v1/policy/effective-app-permissions`, so a `/*`
 * shim would swallow a LIVE route (and turn every unknown `/v1/policy/...` into
 * a false 410 instead of a 404 — the property `removed-routes.test.ts` pins).
 *
 * Unlike the `/agents` and `/connections` shims, these answer without auth: the
 * project policy router carried the blanket `authMiddleware` for this base path
 * and went away with it. A tombstone needs no credentials.
 *
 * The ORG mirror at `/v1/org/policy/*` is untouched and keeps the full surface.
 */
export const removedProjectPolicyRoutes = () => {
  const app = new Hono<ApiEnv>();
  const removed = (what: string) => () =>
    gone(
      `${what} was removed at project scope: project rules are compiled from ` +
        "agent credential grants, not authored directly.",
    );
  app.all("/rules/order", removed("PUT /v1/policy/rules/order"));
  app.all("/rules/:ruleId", removed("/v1/policy/rules/:ruleId"));
  app.all("/rules", removed("/v1/policy/rules"));
  app.all("/default", removed("/v1/policy/default"));
  app.all("/publish", removed("POST /v1/policy/publish"));
  app.all("/last-publish", removed("GET /v1/policy/last-publish"));
  return app;
};

/** The reverse view under `/v1/connections`. */
export const removedConnectionAgentRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/:connectionId/agents", () =>
    gone(
      "/v1/connections/:connectionId/agents was removed: an agent reaches a " +
        "connection through an allow rule naming it. " +
        "GET /v1/connections/:connectionId/effective-agents reports who can, " +
        "read-only.",
    ),
  );
  return app;
};
