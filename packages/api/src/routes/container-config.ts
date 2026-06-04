import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { GATEWAY_BASE_URL } from "../lib/env";
import { loadCaCertificate } from "../lib/gateway-ca";
import {
  parseAnthropicMetadata,
  parseOpenaiMetadata,
} from "../validations/secret";
import { CODEX_OAUTH_STUB } from "../lib/codex-stubs";
import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_IDENTIFIER } from "../lib/constants";
import { generateAccessToken } from "../services/agent-service";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";

const CA_CONTAINER_PATH = "/tmp/onecli-gateway-ca.pem";
const CODEX_HOME_CONTAINER_PATH = "/home/node/.codex";

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
      const projectId = requireProjectId(auth);

      const agentIdentifier = c.req.query("agent");

      let agent = agentIdentifier
        ? await db.agent.findFirst({
            where: { projectId, identifier: agentIdentifier },
            select: { id: true, accessToken: true, secretMode: true },
          })
        : await db.agent.findFirst({
            where: { projectId, isDefault: true },
            select: { id: true, accessToken: true, secretMode: true },
          });

      if (!agent && agentIdentifier) {
        // Fail loud: a container was started for an agent that isn't
        // registered (its POST /api/agents create was rejected or never ran).
        // Without this it manifests as a silent hang -- the container boots,
        // never wires credentials, and never replies. Log it server-side and
        // return an actionable, machine-detectable error so it's traceable.
        logger.warn(
          { projectId, agentIdentifier, route: "GET /v1/container-config" },
          "container config requested for unregistered agent identifier",
        );
        return c.json(
          {
            error: `No agent with identifier "${agentIdentifier}" exists in this project. Create it first via POST /api/agents, or omit the "agent" query parameter to use the project's default agent.`,
            code: "AGENT_NOT_FOUND",
            agentIdentifier,
          },
          404,
        );
      }

      if (!agent) {
        agent = await db.agent.create({
          data: {
            name: DEFAULT_AGENT_NAME,
            identifier: DEFAULT_AGENT_IDENTIFIER,
            accessToken: generateAccessToken(),
            isDefault: true,
            projectId,
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
              select: { metadata: true, encryptedValue: true },
            })
          : await db.secret.findFirst({
              where: { projectId, type: "anthropic" },
              select: { metadata: true, encryptedValue: true },
            });

      const meta = parseAnthropicMetadata(anthropicSecret?.metadata);

      const authEnv: Record<string, string> =
        meta?.authMode === "oauth"
          ? { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" }
          : { ANTHROPIC_API_KEY: "placeholder" };

      // Detect OpenAI auth mode for Codex container support.
      const openaiSecret =
        agent.secretMode === "selective"
          ? await db.secret.findFirst({
              where: {
                type: "openai",
                agentSecrets: { some: { agentId: agent.id } },
              },
              select: { metadata: true },
            })
          : await db.secret.findFirst({
              where: { projectId, type: "openai" },
              select: { metadata: true },
            });

      const openaiMeta = parseOpenaiMetadata(openaiSecret?.metadata);

      const openaiEnv: Record<string, string> = {};
      const credentialStubs: Array<{
        containerPath: string;
        content: string;
      }> = [];

      if (openaiSecret) {
        if (openaiMeta?.authMode === "oauth") {
          openaiEnv.CODEX_HOME = CODEX_HOME_CONTAINER_PATH;
          credentialStubs.push({
            containerPath: `${CODEX_HOME_CONTAINER_PATH}/auth.json`,
            content: CODEX_OAUTH_STUB,
          });
        } else {
          openaiEnv.OPENAI_API_KEY = "placeholder";
        }
      }

      const warnings: string[] = [];
      if (!anthropicSecret) {
        warnings.push(
          "No Anthropic credentials configured — the agent will use its own API key if available. Add one at " +
            (c.req.header("origin") ?? "") +
            "/secrets",
        );
      } else {
        try {
          await getCrypto().decrypt(anthropicSecret.encryptedValue);
        } catch {
          warnings.push(
            "Anthropic credentials exist but cannot be decrypted by the gateway (encryption format mismatch). Re-create the secret to fix this.",
          );
        }
      }

      // Fire-and-forget: mark agent as connected
      markAgentConnected(projectId).catch(() => {});

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
          ...openaiEnv,
        },
        caCertificate,
        caCertificateContainerPath: CA_CONTAINER_PATH,
        ...(credentialStubs.length > 0 && { credentialStubs }),
        ...(warnings.length > 0 && { warnings }),
      });
    } catch (err) {
      logger.error(
        { err, route: "GET /v1/container-config" },
        "container config failed",
      );
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
};
