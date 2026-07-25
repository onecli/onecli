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

const POLICY_CONSOLE =
  "Use /v1/policy — one first-match rule set covering blocks, allows, rate " +
  "limits, approvals, app permissions and credential grants.";

const gone = (what: string): never => {
  throw new ServiceError("GONE", `${what} ${POLICY_CONSOLE}`);
};

/** `/v1/rules/*` — the whole legacy rule CRUD, plus its two read helpers. */
export const removedRuleRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/overlap/:provider", () =>
    gone(
      "GET /v1/rules/overlap/:provider was removed: rule overlap (duplicate, " +
        "conflicting and unreachable rules) is computed by the Policy console.",
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
  app.all("/*", () => gone("/v1/org/rules was removed."));
  app.all("/", () => gone("/v1/org/rules was removed."));
  return app;
};

/** `/v1/org/settings` — carried only the org-wide `policyMode` toggle. */
export const removedOrgSettingsRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.all("/*", () =>
    gone(
      "/v1/org/settings was removed: the allow/deny posture is the scope's " +
        "Default Rule.",
    ),
  );
  app.all("/", () =>
    gone(
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
