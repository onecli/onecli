const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  compress: !isCloud, // Cloud: CloudFront handles compression at the edge; OSS: Next.js compresses
  serverExternalPackages: ["@onecli/db"],
  env: {
    NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION || "oss",
    NEXT_PUBLIC_API_URL: process.env.API_BASE_URL
      ? `${isCloud && process.env.NODE_ENV !== "development" ? "https" : "http"}://${process.env.API_BASE_URL}`
      : "http://localhost:10255",
  },
  turbopack: {
    resolveAlias: isCloud
      ? {
          "@/lib/auth/auth-provider": "@/cloud/auth/cognito-provider",
          "@/lib/auth/auth-server": "@/cloud/auth/cognito-server",
          "@/lib/actions/resolve-user": "@/cloud/auth/resolve-user",
          "@/lib/nav-items": "@/cloud/nav-items",
          "@dashboard/dashboard-sidebar": "@/cloud/dashboard/dashboard-sidebar",
          "@dashboard/dashboard-header": "@/cloud/dashboard/dashboard-header",
          "@/lib/crypto": "@/cloud/kms-crypto",
          "@/lib/gateway-auth": "@/cloud/gateway-auth",
          "@/lib/settings-nav-items": "@/cloud/settings-nav-items",
          "@/lib/auth/login-content": "@/cloud/auth/login-content",
          "@/lib/user-plan": "@/cloud/user-plan",
          "@/lib/auth/session-hooks": "@/cloud/auth/session-hooks",
          "@/lib/deploy/nav-deploy": "@/cloud/deploy/nav-deploy",
          "@/lib/deploy/deploy-page": "@/cloud/deploy/deploy-page",
          "@/lib/deploy/deploy-new-page": "@/cloud/deploy/deploy-new-page",
          "@/lib/components/request-app-slot": "@/cloud/apps/request-app-slot",
          "@/lib/actions/agents": "@/cloud/actions/agents",
          "@/lib/actions/rules": "@/cloud/actions/rules",
          "@/lib/actions/secrets": "@/cloud/actions/secrets",
          "@/lib/home-redirect": "@/cloud/home-redirect",
          "@/lib/dashboard/validate-session":
            "@/cloud/dashboard/validate-session",
        }
      : {},
  },
};

export default nextConfig;
