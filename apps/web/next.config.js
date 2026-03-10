const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "@onecli/db",
    "@electric-sql/pglite",
    "pglite-prisma-adapter",
  ],
  env: {
    NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION || "oss",
    NEXT_PUBLIC_AUTH_MODE: isCloud
      ? "cloud"
      : process.env.NEXTAUTH_SECRET
        ? "oauth"
        : "local",
  },
  turbopack: {
    resolveAlias: isCloud
      ? {
          "@/lib/auth/auth-provider": "@/cloud/auth/cognito-provider",
          "@/lib/auth/auth-server": "@/cloud/auth/cognito-server",
          "@/lib/nav-items": "@/cloud/nav-items",
          "@/lib/crypto": "@/cloud/crypto",
        }
      : {},
  },
};

export default nextConfig;
