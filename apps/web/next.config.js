const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  compress: !isCloud, // Cloud: CloudFront handles compression at the edge; OSS: Next.js compresses
  serverExternalPackages: ["@onecli/db"],
  env: {
    NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION || "oss",
    NEXT_PUBLIC_API_URL: process.env.API_DOMAIN
      ? `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.API_DOMAIN}`
      : "http://localhost:10255",
    NEXT_PUBLIC_GATEWAY_API_URL: process.env.GATEWAY_API_DOMAIN
      ? `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.GATEWAY_API_DOMAIN}`
      : "http://localhost:10255",
  },
  turbopack: {
    resolveAlias: isCloud
      ? {
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
          "@/lib/actions/agents": "@/cloud/actions/agents",
          "@/lib/actions/rules": "@/cloud/actions/rules",
          "@/lib/actions/secrets": "@/cloud/actions/secrets",
          "@/lib/actions/connections": "@/cloud/actions/connections",
          "@/lib/home-redirect": "@/cloud/home-redirect",
          "@/lib/components/pro-app-dialog": "@/cloud/apps/pro-app-dialog",
          "@/lib/components/condition-builder":
            "@/cloud/components/condition-builder",
          "@/lib/dashboard/session-redirect":
            "@/cloud/dashboard/session-redirect",

          // Cloud initialization (api, server actions, client)
          "@/lib/init/api": "@/cloud/init/api",
          "@/lib/init/server": "@/cloud/init/server",
          "@/lib/init/client": "@/cloud/init/client",

          // Cloud API fetch (Bearer token auth for external api-server)
          "@/lib/api-fetch": "@/cloud/api-fetch",
        }
      : {},
  },
};

export default nextConfig;
