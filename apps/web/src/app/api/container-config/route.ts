import { NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { validateApiKey } from "@/lib/validate-api-key";
import { getServerSession } from "@/lib/auth/server";
import { loadCaCertificate } from "@/lib/proxy-ca";

const PROXY_PORT = process.env.PROXY_PORT ?? "10255";
const CA_CONTAINER_PATH = "/tmp/onecli-proxy-ca.pem";

const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

const getProxyHost = (): string => {
  if (process.env.PROXY_HOST) return process.env.PROXY_HOST;
  if (isCloud) {
    throw new Error("PROXY_HOST env var is required in cloud edition");
  }
  return "host.docker.internal";
};

/**
 * GET /api/container-config
 *
 * Returns the configuration an agent orchestrator needs to set up containers
 * for the proxy. The server controls all env var names, values, and paths —
 * the SDK just applies them without domain knowledge.
 *
 * Auth: `Authorization: Bearer oc_...` (user API key) or JWT session.
 */
export async function GET(request: NextRequest) {
  try {
    // Auth: API key or JWT session
    const apiKeyUser = await validateApiKey(request);

    let userId: string | null = null;

    if (apiKeyUser) {
      userId = apiKeyUser.id;
    } else {
      const session = await getServerSession();
      if (session) {
        const user = await db.user.findUnique({
          where: { externalAuthId: session.id },
          select: { id: true },
        });
        userId = user?.id ?? null;
      }
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Look up the user's default agent to embed its token in the proxy URL
    const defaultAgent = await db.agent.findFirst({
      where: { userId, isDefault: true },
      select: { accessToken: true },
    });

    if (!defaultAgent) {
      return NextResponse.json(
        { error: "No default agent found. Please create one first." },
        { status: 404 },
      );
    }

    const proxyHost = getProxyHost();
    const proxyUrl = `http://x:${defaultAgent.accessToken}@${proxyHost}:${PROXY_PORT}`;

    const caCertificate = loadCaCertificate();
    if (!caCertificate) {
      return NextResponse.json(
        {
          error:
            "CA certificate not available. Start the proxy first to generate it.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      env: {
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NODE_EXTRA_CA_CERTS: CA_CONTAINER_PATH,
        NODE_USE_ENV_PROXY: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-...",
        ANTHROPIC_API_KEY: "sk-ant-...",
      },
      caCertificate,
      caCertificateContainerPath: CA_CONTAINER_PATH,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
