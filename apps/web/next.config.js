import { readFileSync } from "node:fs";
import path from "node:path";

const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

// Build-time app version, exposed to the app as NEXT_PUBLIC_APP_VERSION (client +
// server, inlined by Next). Cloud stamps APP_VERSION (semver + short git sha, e.g.
// "1.38.0+f6cca6e5") as a build arg; onprem / self-host / local falls back to the
// monorepo root package.json version, else "dev". process.cwd() is apps/web here.
const resolveAppVersion = () => {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const pkg = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "..", "..", "package.json"),
        "utf8",
      ),
    );
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
};
const appVersion = resolveAppVersion();

// `next dev` only (see `rewrites` below): NODE_ENV is "development" exactly
// under the dev server, so production builds bake no rewrites at all.
const isDev = process.env.NODE_ENV === "development";

// Where the dev server proxies `/v1`, better-auth and the gateway to. These are
// the services' addresses on the local network — deliberately NOT the public
// `API_URL`/`GATEWAY_API_URL`: a dev who points those at a tunnel would send
// the proxy hop back out through the tunnel it came from (web → tunnel → web,
// a loop). The same internal-address vars the rest of the stack already uses.
const devApiUrl = (
  process.env.INTERNAL_API_URL ?? "http://localhost:10256"
).replace(/\/+$/, "");
const devGatewayUrl = (
  process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:10255"
).replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Cloud: CloudFront compresses at the edge. Onprem prod: Next.js compresses.
  // Dev: OFF — the dev server's gzip middleware buffers proxied responses, and
  // the single-origin rewrites now carry the conversation SSE stream and the
  // approvals long-poll through it; compressing those would stall live chat
  // until the stream ended. Dev has no bandwidth concern to trade for it.
  compress: !isCloud && !isDev,
  serverExternalPackages: ["@onecli/db", "@1password/sdk"],
  env: {
    // One codebase, two editions selected at runtime: `cloud` (the hosted
    // platform) or `onprem` (self-hosted — the default). No build-time module
    // swapping: code branches on the CAPS/IS_CLOUD capability layer instead.
    NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION || "onprem",
    NEXT_PUBLIC_APP_VERSION: appVersion,
    // Baked ONLY when a value was actually provided — full URLs first (what
    // cloud CI passes), the bare-domain vars as a DEPRECATED fallback for
    // older build invocations. LEGACY(next-major): delete the fallback here
    // and the API_DOMAIN/GATEWAY_API_DOMAIN rows in turbo.json together
    // (ledger: packages/api/src/lib/public-origins.ts).
    //
    // No localhost fallback here, deliberately: an env{} key is INLINED into
    // the SERVER bundle too, where a baked localhost would read as a
    // configured override and beat the resolver's runtime derivation (the
    // prebuilt self-host image would advertise localhost regardless of
    // ONECLI_EXTERNAL_URL). Left un-baked, the server reads runtime env and
    // the browser bottoms out at the resolver's identical code default.
    ...(process.env.NEXT_PUBLIC_API_URL || process.env.API_DOMAIN
      ? {
          NEXT_PUBLIC_API_URL:
            process.env.NEXT_PUBLIC_API_URL ||
            `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.API_DOMAIN}`,
        }
      : {}),
    ...(process.env.NEXT_PUBLIC_GATEWAY_API_URL ||
    process.env.GATEWAY_API_DOMAIN
      ? {
          NEXT_PUBLIC_GATEWAY_API_URL:
            process.env.NEXT_PUBLIC_GATEWAY_API_URL ||
            `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.GATEWAY_API_DOMAIN}`,
        }
      : {}),
  },
  // `redirects()` carries MOVED routes only — never retired ones. The legacy
  // Rules page and the policyMode toggle still 404 like any other removed
  // route, because there is nowhere left to send them.
  //
  // The /p/ → /w/ rules exist only for the project→workspace rename
  // (temporary — remove with the compat layer, see
  // packages/api/src/lib/legacy-project-compat.ts): ids survived the rename
  // migration verbatim, so old /p/ deep links map 1:1 onto /w/.
  redirects: async () => [
    // Every pre-rename deep link ever delivered (bookmarks, Slack approval
    // notifications, gateway-minted connect URLs). Permanent: /p/ is never
    // coming back, so a cached 308 stays correct even after this rule goes.
    // `:path+` (not `*`): a bare /p never existed, so it stays a plain 404
    // instead of a permanently-cached redirect to an equally-bare /w.
    { source: "/p/:path+", destination: "/w/:path+", permanent: true },
    // The docs' two hardcoded pre-org dashboard links.
    { source: "/projects", destination: "/", permanent: false },
    // Install did not retire, it moved under Workspace Settings, and the
    // setup one-liner it shows is exactly the kind of page people bookmark
    // and paste to a teammate. Permanent, because the move is.
    {
      source: "/w/:workspaceId/install",
      destination: "/w/:workspaceId/settings/install",
      permanent: true,
    },
  ],
  //
  // `rewrites()` exists for exactly one reason: to serve the whole DEV stack
  // on a SINGLE ORIGIN. better-auth issues the session cookie for the host
  // that answered, and browsers scope cookies by host — so in dev, where the
  // dashboard (:10254), api-server (:10256) and gateway (:10255) are separate
  // processes, one tunnel (ngrok, Cloudflare Tunnel) in front of any single
  // port could never carry a session. Proxying the API's prefixes and the
  // gateway under the dev server's own origin means one tunnel to :10254
  // serves the whole product, and the cookie is always same-origin.
  //
  // Dev only: production self-hosts either share one hostname (ports differ —
  // cookies don't care) or split onto sibling subdomains, where the session
  // cookie spans the shared parent domain (see `resolveCookieDomain` in
  // @onecli/api). Production browsers talk to the api-server directly.
  //
  // `afterFiles`, never `beforeFiles`: the filesystem router must win first,
  // or these would shadow the dashboard's own `/auth/login`, `/auth/signup`,
  // `/auth/cli` pages and the `/v1/health` deploy probe. `/gw` is a stripped
  // prefix of our own invention — the gateway's browser routes live under
  // `/v1/*` too, so they'd collide with the api-server's without one. Dev-only
  // but edition-agnostic: cloud PRODUCTION has CloudFront and a bearer token,
  // but cloud DEV behind one tunnel needs the same single origin. For that
  // cloud-dev tunnel, set BOTH baked vars at dev-server start —
  // NEXT_PUBLIC_API_URL=<tunnel-origin> and
  // NEXT_PUBLIC_GATEWAY_API_URL=<tunnel-origin>/gw — since cloud skips the
  // runtime origin injection onprem gets; these rewrites then carry both legs.
  rewrites: !isDev
    ? undefined
    : async () => ({
        afterFiles: [
          { source: "/v1/:path*", destination: `${devApiUrl}/v1/:path*` },
          { source: "/auth/:path*", destination: `${devApiUrl}/auth/:path*` },
          { source: "/gw/:path*", destination: `${devGatewayUrl}/:path*` },
        ],
      }),
  // The proxy above holds long-lived responses open — the approvals long-poll
  // sits silent for ~30s and the conversation stream is an indefinite SSE.
  // Next's proxy defaults to a 30s timeout, which would clip both; this is an
  // inactivity timeout, so heartbeat-bearing streams live indefinitely under
  // it. Inert outside dev (no rewrites exist to proxy).
  experimental: {
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
