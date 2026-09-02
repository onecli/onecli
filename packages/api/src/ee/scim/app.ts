import { Hono } from "hono";
import { logger } from "../../lib/logger";
import { rateLimit } from "../middleware/rate-limit";
import { scimAuth, type ScimEnv } from "./auth";
import { discoveryRouter } from "./discovery";
import { scimErrorBody, toScimError } from "./errors";
import { groupsRouter } from "./groups";
import { scimJson } from "./respond";
import { usersRouter } from "./users";

const log = logger.child({ component: "scim" });

/**
 * The SCIM 2.0 dialect app, served at /scim/v2 on BOTH hosts (api-server
 * mounts it on its outer root; the web app no longer re-exports it — the api-server mounts it directly
 * route). Its own Hono app — createApiApp hard-nails basePath("/v1"), and
 * SCIM is a separate protocol surface with its own auth (bearer tokens, not
 * sessions or oc_ API keys), error shape, and content type.
 *
 * Chain: bearer auth → per-token rate limit → resource routes. Everything,
 * discovery included, sits behind the token. The rate-limit 429 is the
 * generic API shape (not SCIM-shaped) — IdPs back off on the status code.
 *
 * Conformance: `pnpm --filter @onecli/api test:scim` runs the RFC-audited
 * suites locally. Against a DEPLOYED endpoint, run the vendor validators
 * (both are hosted tools, not CLIs): Okta's "SCIM 2.0 SPEC Test"
 * (developer.okta.com/standards/SCIM/SCIMFiles/Okta-SCIM-20-SPEC-Test.json,
 * imported into Runscope/BlazeMeter; set SCIMBaseURL + auth) and
 * Microsoft's Entra SCIM Validator (scimvalidator.microsoft.com).
 */
export const createScimApp = () => {
  const app = new Hono<ScimEnv>();

  app.use("*", scimAuth);
  app.use(
    "*",
    rateLimit<ScimEnv>({
      name: "scim",
      limit: 600,
      windowSeconds: 60,
      key: (c) => c.get("scim").tokenId,
    }),
  );

  // RFC 7644 §3.11: a provider that does not support /Me SHOULD answer 501
  // (the generic 404 would misread as "bad URL" rather than "unsupported").
  app.all("/Me", (c) =>
    scimJson(c, scimErrorBody(501, "The /Me endpoint is not supported."), 501),
  );

  app.route("/Users", usersRouter);
  app.route("/Groups", groupsRouter);
  app.route("/", discoveryRouter);

  // SCIM-shaped 404 as a catch-all ROUTE, not (only) a notFound handler:
  // Hono drops a mounted sub-app's notFound (misses fall through to the
  // HOST app's generic handler — empirically verified), but routes travel
  // through app.route(). Registered last, so every real route wins first.
  const scimNotFound = (c: Parameters<typeof scimJson>[0]) =>
    scimJson(
      c,
      scimErrorBody(
        404,
        `No SCIM resource at ${c.req.method} ${new URL(c.req.url).pathname}.`,
      ),
      404,
    );
  app.all("*", scimNotFound);
  app.notFound(scimNotFound);

  app.onError((err, c) => {
    const scimError = toScimError(err);
    if (scimError) {
      return scimJson(
        c,
        scimErrorBody(scimError.status, scimError.message, scimError.scimType),
        scimError.status,
      );
    }
    log.error({ err }, "unhandled scim error");
    return scimJson(
      c,
      scimErrorBody(500, "An unexpected error occurred."),
      500,
    );
  });

  return app;
};
