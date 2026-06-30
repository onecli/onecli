import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

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

// Cloud edition swaps these web import paths to cloud implementations (turbopack
// resolveAlias, applied only when isCloud). The canonical key list is mirrored in
// packages/api/src/lib/edition.ts (CLOUD_ALIAS_KEYS) — kept here too because this
// config runs in plain Node and can't import that TypeScript module. A future
// onprem edition would select a subset of these here.
const CLOUD_ALIASES = {
  "@/lib/auth/auth-provider": "@/cloud/auth/cognito-provider",
  "@/lib/auth/auth-server": "@/cloud/auth/cognito-server",
  "@/lib/actions/resolve-user": "@/cloud/auth/resolve-user",
  "@/lib/nav-config": "@/cloud/nav-config",
  "@dashboard/dashboard-sidebar": "@/cloud/dashboard/dashboard-sidebar",
  "@dashboard/dashboard-header": "@/cloud/dashboard/dashboard-header",
  "@/lib/gateway-auth": "@/cloud/gateway-auth",
  "@/lib/auth/login-content": "@/cloud/auth/login-content",
  "@/lib/user-plan": "@/cloud/user-plan",
  "@/lib/components/request-app-slot": "@/cloud/apps/request-app-slot",
  "@/lib/home-redirect": "@/cloud/home-redirect",
  "@/lib/components/pro-app-dialog": "@/cloud/apps/pro-app-dialog",
  "@/lib/components/condition-builder": "@/cloud/components/condition-builder",
  "@/lib/dashboard/session-redirect": "@/cloud/dashboard/session-redirect",
  "@/lib/granular-access": "@/cloud/granular-access",
  "@/lib/plan-gate": "@/cloud/billing/plan-gate",

  // Cloud initialization (api, server actions, client)
  "@/lib/init/api": "@/cloud/init/api",
  "@/lib/init/server": "@/cloud/init/server",
  "@/lib/init/client": "@/cloud/init/client",

  // Cloud API fetch (Bearer token auth for external api-server)
  "@/lib/api-fetch": "@/cloud/api-fetch",
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
    resolveAlias: isCloud ? CLOUD_ALIASES : {},
  },
  async rewrites() {
    // Cloud ships the OSS bare dashboard routes too (cloud may only add files), but only
    // serves them namespaced under /p, /org, /account. Shadow each bare path (and its
    // subpaths) before the filesystem route matches, rewriting to Next's built-in
    // not-found route ("/_not-found") so the existing app/not-found.tsx renders with a
    // real 404 and the requested URL is preserved. OSS edition: no-op.
    if (!isCloud) return [];
    const beforeFiles = getOssDashboardSegments().flatMap((seg) => [
      { source: seg, destination: "/_not-found" },
      { source: `${seg}/:path*`, destination: "/_not-found" },
    ]);
    return { beforeFiles };
  },
};

export default nextConfig;
