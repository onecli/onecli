const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["@onecli/db"],
  env: {
    NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION || "oss",
  },
  turbopack: {
    resolveAlias: isCloud
      ? {
          "@/lib/auth/auth-provider": "@/cloud/auth/cognito-provider",
          "@/lib/auth/auth-server": "@/cloud/auth/cognito-server",
          "@/lib/nav-items": "@/cloud/nav-items",
          "@/lib/crypto": "@/cloud/kms-crypto",
        }
      : {},
  },
};

export default nextConfig;
