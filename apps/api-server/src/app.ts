import { Hono } from "hono";
import { cors } from "hono/cors";
import { createApiApp } from "@onecli/api";
import { createScimApp } from "@onecli/api/ee/scim";
import { eeSessionHooks } from "@onecli/api/ee/auth/session-hooks";
import { IS_CLOUD } from "@onecli/api/lib/env";
import {
  apiOrigin,
  appOrigin,
  trustedBrowserOrigin,
} from "@onecli/api/lib/public-origins";
import { LEGACY_PROJECT_HEADER } from "@onecli/api/lib/legacy-project-compat";
import {
  BETTER_AUTH_BASE_PATH,
  getOnpremAuth,
} from "@onecli/api/lib/better-auth";
import { onpremSessionProvider } from "@onecli/api/lib/onprem-session-provider";
import { onpremSessionHooks } from "@onecli/api/lib/onprem-session-hooks";
import { cognitoSessionProvider } from "./cognito-session-provider";
import { requestLogger } from "./middleware/request-logger";

const appUrl = appOrigin();

// The api-server is the only API server in every edition. Every provider —
// crypto, org OAuth, quotas, SSO enforcement, the EE routes — resolves from
// the edition defaults inside `createApiApp`. Host-passed here: the session
// provider (Cognito bearer on cloud; cookie/local on onprem), this server's
// own public origin (OAuth callbacks must come back to the API host, not the
// web app), and the cloud session hooks (they have no edition default).
const apiApp = createApiApp(
  IS_CLOUD ? cognitoSessionProvider : onpremSessionProvider,
  {
    selfUrl: apiOrigin(),
    sessionHooks: IS_CLOUD ? eeSessionHooks : onpremSessionHooks,
    version: process.env.APP_VERSION || undefined,
  },
);

export const app = new Hono();

// Cloud pins the dashboard origin. Self-host answers with the origin only when
// it is one this deployment already trusts — the same set the auth layer
// enforces at sign-in (app/api origins, their loopback twins, any
// ONECLI_TRUSTED_ORIGINS extras). Reflecting whatever Origin arrived, which is
// what this did before, hands `credentials: true` to every site the user's
// browser visits; `SameSite=lax` does not close it, being site-scoped rather
// than origin-scoped (a sibling subdomain is same-site and carries the session
// cookie). An install reachable at an address none of those yield lists it in
// ONECLI_TRUSTED_ORIGINS — the same line that already unblocks its sign-in.
app.use(
  "*",
  cors({
    origin: IS_CLOUD
      ? [appUrl]
      : (origin) => trustedBrowserOrigin(origin) ?? null,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "X-Workspace-Id",
      "X-Organization-Id",
      // Rename compat (temporary): old browser callers still send it.
      LEGACY_PROJECT_HEADER,
    ],
    credentials: true,
  }),
);

app.use("*", requestLogger);

app.route("/", apiApp);

// SCIM 2.0 provisioning — its own app on the outer root: a separate protocol
// surface (bearer-token auth, SCIM error shape, application/scim+json) that
// must not live under the /v1 basePath. The canonical documented base URL is
// this host's /scim/v2.
app.route("/scim/v2", createScimApp());

// The self-hosted identity layer (better-auth), likewise its own surface on
// the outer root — sign-in, sign-out, the OAuth callback. Cloud authenticates
// with Cognito and never mounts it, so the endpoints simply do not exist
// there. `/v1/auth/session` is ours and unrelated: it syncs whatever identity
// authenticated into an org/workspace, whichever edition resolved it.
if (!IS_CLOUD) {
  app.on(["GET", "POST"], `${BETTER_AUTH_BASE_PATH}/*`, (c) =>
    getOnpremAuth().handler(c.req.raw),
  );
}

app.notFound((c) =>
  c.json(
    {
      error: {
        message: `Unrecognized request URL (${c.req.method}: ${c.req.path}). Please see https://onecli.sh/docs/api-reference for available endpoints.`,
        type: "invalid_request_error",
      },
    },
    404,
  ),
);

// Backwards-compatible: /api/* → /v1/*
app.all("/api/*", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = `/v1${url.pathname.slice(4)}`;
  return apiApp.fetch(new Request(url.toString(), c.req.raw));
});
