import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";
const isOnpremFull = process.env.NEXT_PUBLIC_EDITION === "onprem-full";
const isOnpremSlim = process.env.NEXT_PUBLIC_EDITION === "onprem-slim";

// Build-time app version, exposed to the app as NEXT_PUBLIC_APP_VERSION (client +
// server, inlined by Next). Cloud stamps APP_VERSION (semver + short git sha, e.g.
// "1.38.0+f6cca6e5") as a build arg; OSS / self-host / local falls back to the
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

// Dashboard paths that cloud intentionally serves at the SAME bare URL as OSS (shared).
// Empty today: cloud namespaces every dashboard feature under /p, /org, /account, so no
// bare (dashboard) path is shared. Escape hatch if OSS ever adds a dashboard route cloud
// also wants to keep bare — add it here and it won't be 404'd.
const CLOUD_SHARED_DASHBOARD_PATHS = new Set([]);

// Bare OSS dashboard route segments, read from the filesystem at build time so new OSS
// dashboard routes are covered automatically with no list to maintain. Excludes route
// groups "(x)", private "_x", dynamic "[x]", parallel "@x", and files via a positive
// name pattern. process.cwd() is apps/web during `next dev`/`next build`.
const getOssDashboardSegments = () => {
  const dir = path.join(process.cwd(), "src", "app", "(dashboard)");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
      .map((e) => `/${e.name}`)
      .filter((p) => !CLOUD_SHARED_DASHBOARD_PATHS.has(p));
  } catch {
    return [];
  }
};

// All EE editions (cloud + both onprems) resolve app credentials project →
// org → env; the RSC/server-action seed (`checkAppConfigExists`) must see the
// same org tier, so the action is swapped for an org-aware variant.
const ORG_APP_CONFIG_ALIASES = {
  "@/lib/actions/app-config": "@/ee/actions/app-config",
};

// Cloud edition swaps these web import paths to cloud implementations (turbopack
// resolveAlias, applied only when isCloud). This config runs in plain Node, so the
// key→value map lives here directly. The onprem-full edition selects a curated
// subset below (ONPREM_FULL_ALIASES).
const CLOUD_ALIASES = {
  ...ORG_APP_CONFIG_ALIASES,
  "@/lib/auth/auth-provider": "@/ee/auth/cognito-provider",
  "@/lib/auth/auth-server": "@/ee/auth/cognito-server",
  "@/lib/actions/resolve-user": "@/ee/auth/resolve-user",
  "@/lib/nav-config": "@/ee/nav-config",
  "@dashboard/dashboard-sidebar": "@/ee/dashboard/dashboard-sidebar",
  "@dashboard/dashboard-header": "@/ee/dashboard/dashboard-header",
  "@/lib/gateway-auth": "@/ee/gateway-auth",
  "@/lib/auth/login-content": "@/ee/auth/login-content",
  "@/lib/user-plan": "@/ee/user-plan",
  "@/lib/components/request-app-slot": "@/ee/apps/request-app-slot",
  "@/lib/home-redirect": "@/ee/home-redirect",
  "@/lib/components/pro-app-dialog": "@/ee/apps/pro-app-dialog",
  "@/lib/components/condition-builder": "@/ee/components/condition-builder",
  "@/lib/dashboard/session-redirect": "@/ee/dashboard/session-redirect",
  "@/lib/granular-access": "@/ee/granular-access",
  "@/lib/plan-gate": "@/ee/billing/plan-gate",

  // Cloud initialization (api, server actions, client)
  "@/lib/init/api": "@/ee/init/api",
  "@/lib/init/server": "@/ee/init/server",
  "@/lib/init/client": "@/ee/init/client",

  // Cloud API fetch (Bearer token auth for external api-server)
  "@/lib/api-fetch": "@/ee/api-fetch",
};

// Both onprem editions inject the real cloud app definitions via an onprem init seam
// (api/server/client) so the cloud-only apps are connectable with the customer's own
// OAuth credentials (BYO), while keeping local crypto/auth (no KMS/Cognito/cloud routes).
const ONPREM_INIT_ALIASES = {
  "@/lib/init/api": "@/ee/onprem/init/api",
  "@/lib/init/server": "@/ee/onprem/init/server",
  "@/lib/init/client": "@/ee/onprem/init/client",
};

// Both onprem editions are the fully-entitled enterprise edition: report the top
// plan (so premium/teamOnly apps + features aren't shown as locked) and get the
// granular-access policy dialogs. The backend already allows everything for onprem.
const ONPREM_ENTITLEMENT_ALIASES = {
  "@/lib/user-plan": "@/ee/onprem/user-plan",
  "@/lib/granular-access": CLOUD_ALIASES["@/lib/granular-access"],
};

// The onprem-full edition reuses the cloud ORG-UI implementations + the org-aware home
// redirect (org routes, nav, dashboard chrome) but keeps the OSS defaults for auth
// (local), resolve-user (its project context already works for a single org), and billing
// (none). It adds the onprem init seam (cloud app defs) + one onprem-specific module:
// api-fetch (local cookie auth + project-scoped headers, no bearer token). The cloud
// org-context helpers are imported directly by the org pages and work as-is for onprem
// (members are "owner").
const ONPREM_FULL_ALIASES = {
  ...ONPREM_INIT_ALIASES,
  ...ONPREM_ENTITLEMENT_ALIASES,
  ...ORG_APP_CONFIG_ALIASES,
  // org-UI + org-aware redirect → cloud implementations (reuse the cloud mappings above)
  "@/lib/nav-config": CLOUD_ALIASES["@/lib/nav-config"],
  "@dashboard/dashboard-sidebar": CLOUD_ALIASES["@dashboard/dashboard-sidebar"],
  "@dashboard/dashboard-header": CLOUD_ALIASES["@dashboard/dashboard-header"],
  "@/lib/dashboard/session-redirect":
    CLOUD_ALIASES["@/lib/dashboard/session-redirect"],
  "@/lib/home-redirect": CLOUD_ALIASES["@/lib/home-redirect"],
  // onprem-specific: local cookie auth + project-scoped headers
  "@/lib/api-fetch": "@/ee/onprem/api-fetch",
};

// onprem-slim keeps the flat OSS surface (local auth, OSS api-fetch) + only adds the
// onprem init seam so cloud apps are connectable via BYO.
const ONPREM_SLIM_ALIASES = {
  ...ONPREM_INIT_ALIASES,
  ...ONPREM_ENTITLEMENT_ALIASES,
  ...ORG_APP_CONFIG_ALIASES,
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  compress: !isCloud, // Cloud: CloudFront handles compression at the edge; OSS: Next.js compresses
  serverExternalPackages: ["@onecli/db", "@1password/sdk"],
  env: {
    NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION || "oss",
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_API_URL: process.env.API_DOMAIN
      ? `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.API_DOMAIN}`
      : "http://localhost:10255",
    NEXT_PUBLIC_GATEWAY_API_URL: process.env.GATEWAY_API_DOMAIN
      ? `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.GATEWAY_API_DOMAIN}`
      : "http://localhost:10255",
  },
  turbopack: {
    resolveAlias: isCloud
      ? CLOUD_ALIASES
      : isOnpremFull
        ? ONPREM_FULL_ALIASES
        : isOnpremSlim
          ? ONPREM_SLIM_ALIASES
          : {},
  },
  async rewrites() {
    // Cloud and onprem-full ship the OSS bare dashboard routes too (they may only add
    // files), but only serve them namespaced under /p, /org, /account. Shadow each bare
    // path (and its subpaths) before the filesystem route matches, rewriting to Next's
    // built-in not-found route ("/_not-found") so the existing app/not-found.tsx renders
    // with a real 404 and the requested URL is preserved. Flat editions (oss,
    // onprem-slim): no-op.
    if (!isCloud && !isOnpremFull) return [];
    const beforeFiles = getOssDashboardSegments().flatMap((seg) => [
      { source: seg, destination: "/_not-found" },
      { source: `${seg}/:path*`, destination: "/_not-found" },
    ]);
    return { beforeFiles };
  },
};

export default nextConfig;
