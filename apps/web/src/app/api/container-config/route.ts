import { NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { resolveApiAuth } from "@/lib/api-auth";
import { unauthorized } from "@/lib/api-utils";
import { loadCaCertificate } from "@/lib/gateway-ca";

const GATEWAY_PORT = process.env.GATEWAY_PORT ?? "10255";
const CA_CONTAINER_PATH = "/tmp/onecli-gateway-ca.pem";

const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

const getGatewayHost = (): string => {
  if (process.env.GATEWAY_HOST) return process.env.GATEWAY_HOST;
  if (isCloud) {
    throw new Error("GATEWAY_HOST env var is required in cloud edition");
  }
  return "host.docker.internal";
};

/**
 * GET /api/container-config
 *
 * Returns the configuration an agent orchestrator needs to set up containers
 * for the gateway. The server controls all env var names, values, and paths —
 * the SDK just applies them without domain knowledge.
 *
 * Auth: `Authorization: Bearer oc_...` (user API key) or JWT session.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    // Look up agent: by identifier if provided, otherwise default
    const agentIdentifier = request.nextUrl.searchParams.get("agent");

    const agent = agentIdentifier
      ? await db.agent.findFirst({
          where: { userId: auth.userId, identifier: agentIdentifier },
          select: { accessToken: true },
        })
      : await db.agent.findFirst({
          where: { userId: auth.userId, isDefault: true },
          select: { accessToken: true },
        });

    if (!agent) {
      return NextResponse.json(
        {
          error: agentIdentifier
            ? "Agent with the given identifier not found."
            : "No default agent found. Please create one first.",
        },
        { status: 404 },
      );
    }

    const gatewayHost = getGatewayHost();
    const gatewayUrl = `http://x:${agent.accessToken}@${gatewayHost}:${GATEWAY_PORT}`;

    const caCertificate = loadCaCertificate();
    if (!caCertificate) {
      return NextResponse.json(
        {
          error:
            "CA certificate not available. Start the gateway first to generate it.",
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      env: {
        HTTPS_PROXY: gatewayUrl,
        HTTP_PROXY: gatewayUrl,
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
