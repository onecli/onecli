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
      ? `${isCloud ? "https" : "http"}://${process.env.API_BASE_URL}`
      : "http://localhost:10255",
  },
  turbopack: {
    resolveAlias: isCloud
      ? {
          "@/lib/auth/auth-provider": "@/cloud/auth/cognito-provider",
          "@/lib/auth/auth-server": "@/cloud/auth/cognito-server",
          "@/lib/nav-items": "@/cloud/nav-items",
          "@/lib/crypto": "@/cloud/kms-crypto",
          "@/lib/gateway-auth": "@/cloud/gateway-auth",
          "@/lib/settings-nav-items": "@/cloud/settings-nav-items",
          "@/lib/auth/login-content": "@/cloud/auth/login-content",
          "@/lib/user-plan": "@/cloud/user-plan",
          "@/lib/auth/session-hooks": "@/cloud/auth/session-hooks",
        }
      : {},
  },
};

export default nextConfig;
