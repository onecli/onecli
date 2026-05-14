import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { GATEWAY_BASE_URL } from "../lib/env";
import { loadCaCertificate } from "../lib/gateway-ca";
import { parseAnthropicMetadata } from "../validations/secret";
import { DEFAULT_AGENT_NAME } from "../lib/constants";
import { generateAccessToken } from "../services/agent-service";
import { logger } from "../lib/logger";

const CA_CONTAINER_PATH = "/tmp/onecli-gateway-ca.pem";

/**
 * Mark the onboarding survey to record that the agent container is up.
 * Skips the write if already marked to avoid repeated DB calls.
 */
const markAgentConnected = async (projectId: string) => {
  const survey = await db.onboardingSurvey.findUnique({
    where: { projectId },
    select: { setupState: true },
  });

  if (!survey) return;

  const state =
    survey.setupState && typeof survey.setupState === "object"
      ? (survey.setupState as Record<string, unknown>)
      : {};

  if (state.connectedAt) return;

  await db.onboardingSurvey.update({
    where: { projectId },
    data: {
      setupState: {
        ...state,
        connectedAt: new Date().toISOString(),
      },
    },
  });
};

export const containerConfigRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  /**
   * GET /container-config
   *
   * Returns the configuration an agent orchestrator needs to set up containers
   * for the gateway. The server controls all env var names, values, and paths --
   * the SDK just applies them without domain knowledge.
   */
  app.get("/", async (c) => {
    try {
      const auth = c.get("auth");

      // Look up agent: by identifier if provided, otherwise default.
      // Auto-creates the default agent on first call so `docker run` works
      // without needing to open the dashboard first.
      const agentIdentifier = c.req.query("agent");

      let agent = agentIdentifier
        ? await db.agent.findFirst({
            where: { projectId: auth.projectId, identifier: agentIdentifier },
            select: { id: true, accessToken: true, secretMode: true },
          })
        : await db.agent.findFirst({
            where: { projectId: auth.projectId, isDefault: true },
            select: { id: true, accessToken: true, secretMode: true },
          });

      if (!agent && agentIdentifier) {
        return c.json(
          { error: "Agent with the given identifier not found." },
          404,
        );
      }

      if (!agent) {
        agent = await db.agent.create({
          data: {
            name: DEFAULT_AGENT_NAME,
            accessToken: generateAccessToken(),
            isDefault: true,
            projectId: auth.projectId,
          },
          select: { id: true, accessToken: true, secretMode: true },
        });
      }

      const gatewayUrl = `http://x:${agent.accessToken}@${GATEWAY_BASE_URL}`;

      const caCertificate = loadCaCertificate();
      if (!caCertificate) {
        return c.json(
          {
            error:
              "CA certificate not available. Start the gateway first to generate it.",
          },
          503,
        );
      }

      // Detect auth mode from the agent's Anthropic secret metadata.
      // In selective mode, only check secrets assigned to this agent.
      // OAuth tokens need CLAUDE_CODE_OAUTH_TOKEN so the SDK does the token
      // exchange. API keys need ANTHROPIC_API_KEY. Defaults to api-key for
      // legacy secrets without metadata.
      const anthropicSecret =
        agent.secretMode === "selective"
          ? await db.secret.findFirst({
              where: {
                type: "anthropic",
                agentSecrets: { some: { agentId: agent.id } },
              },
              select: { metadata: true },
            })
          : await db.secret.findFirst({
              where: { projectId: auth.projectId, type: "anthropic" },
              select: { metadata: true },
            });

      const meta = parseAnthropicMetadata(anthropicSecret?.metadata);

      const authEnv: Record<string, string> =
        meta?.authMode === "oauth"
          ? { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" }
          : { ANTHROPIC_API_KEY: "placeholder" };

      // Fire-and-forget: mark agent as connected
      markAgentConnected(auth.projectId).catch(() => {});

      return c.json({
        env: {
          // Proxy -- uppercase + lowercase (some tools only check one)
          HTTPS_PROXY: gatewayUrl,
          HTTP_PROXY: gatewayUrl,
          https_proxy: gatewayUrl,
          http_proxy: gatewayUrl,
          // Node.js
          NODE_EXTRA_CA_CERTS: CA_CONTAINER_PATH,
          NODE_USE_ENV_PROXY: "1",
          // Git
          GIT_TERMINAL_PROMPT: "0",
          GIT_HTTP_PROXY_AUTHMETHOD: "basic",
          ...authEnv,
        },
        caCertificate,
        caCertificateContainerPath: CA_CONTAINER_PATH,
      });
    } catch (err) {
      logger.error(
        { err, route: "GET /api/container-config" },
        "container config failed",
      );
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
};
