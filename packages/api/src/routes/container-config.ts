import { Hono } from "hono";
import { db, type Prisma } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { GATEWAY_BASE_URL } from "../lib/env";
import { loadCaCertificate } from "../lib/gateway-ca";
import {
  parseAnthropicMetadata,
  parseOpenaiMetadata,
} from "../validations/secret";
import { buildCodexOAuthStub } from "../lib/codex-stubs";
import { DEFAULT_AGENT_NAME, DEFAULT_AGENT_IDENTIFIER } from "../lib/constants";
import { generateAccessToken } from "../services/agent-service";
import { grantedSecretSelection } from "../services/policy-reflect/injection";
import { loadInjectionRules } from "../services/policy-simulate/load-rules";
import { resolvePrincipalSet } from "../services/policy-simulate/principal-set";
import { getCrypto } from "../providers";
import { logger } from "../lib/logger";

/**
 * A `where` selecting exactly the secrets this agent can be handed.
 *
 * "all" mode takes the whole org+project fenced pool (rules never narrow it,
 * matching `connect.rs`). "selective" takes the same pool NARROWED to what its
 * published rules grant — specific secret ids plus any whole-level grants — and
 * a selective agent with no grants selects NOTHING, the same fail-closed answer
 * the gateway gives, rather than falling back to the pool.
 *
 * The pool is ANDed in rather than trusted away: the gateway selects by fetching
 * the org/project-fenced pool and RETAINING the named ids (`connect.rs`), so a
 * rule naming a foreign secret contributes nothing. Fencing only the RULES would
 * not fence their target ids — write-time validation is a write-path invariant,
 * not a query fence, and these rows were materialized by the retired bridge
 * rather than through it.
 */
export const injectableSecretWhere = async (
  agent: { id: string; secretMode: string },
  projectId: string,
  organizationId: string,
): Promise<Prisma.SecretWhereInput> => {
  const pool: Prisma.SecretWhereInput = {
    OR: [{ projectId }, { organizationId, scope: "organization" }],
  };
  if (agent.secretMode !== "selective") return pool;

  const [principals, orgRules, projectRules] = await Promise.all([
    resolvePrincipalSet(projectId, organizationId),
    loadInjectionRules({ scope: "organization", organizationId }, "published"),
    loadInjectionRules({ scope: "project", projectId }, "published"),
  ]);
  const granted = grantedSecretSelection(
    [...orgRules, ...projectRules],
    agent.id,
    principals,
  );

  // Level grants match the secret's own `scope` column, which is what the
  // gateway compares (`selection.secret_scopes.contains(&s.scope)`).
  const arms: Prisma.SecretWhereInput[] = [];
  if (granted.ids.length > 0) arms.push({ id: { in: granted.ids } });
  if (granted.levels.has("project")) arms.push({ scope: "project" });
  if (granted.levels.has("organization")) arms.push({ scope: "organization" });
  // No grants → match nothing, never the pool.
  if (arms.length === 0) return { id: { in: [] } };
  return { AND: [pool, { OR: arms }] };
};

/**
 * Which secret wins when several of a type are reachable. The gateway merges its
 * all-mode pool partner → org → project with later injections overriding earlier
 * (`connect.rs`), so the PROJECT one is what actually gets injected. Descending
 * `scope` orders "project" > "partner" > "organization", reproducing that — an
 * unordered `findFirst` returns whichever row Postgres reaches first, which can
 * hand the container an org secret's auth mode while the gateway injects the
 * project's.
 */
const SCOPE_PRECEDENCE = { scope: "desc" } as const;

/** Pick the secret of `type` this agent would actually be handed: the injectable
 * set, narrowed to the type, resolved in the gateway's precedence order. Both
 * LLM lookups go through here so the ordering can't drift between them. */
export const findInjectableSecretOfType = async <S extends Prisma.SecretSelect>(
  where: Prisma.SecretWhereInput,
  type: string,
  select: S,
) =>
  db.secret.findFirst({
    where: { AND: [where, { type }] },
    select,
    orderBy: SCOPE_PRECEDENCE,
  });

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

      // Which credentials this agent can actually be handed — the same answer
      // the gateway reaches at connect. An "all"-mode agent draws the whole
      // fenced pool; a "selective" one draws exactly what its published rules
      // grant, which since step 10 is the ONLY source (the legacy per-agent
      // grant tables are frozen and unread, so reading them here would miss
      // every credential granted the normal way — and hand the container an API
      // key for what is actually an OAuth token).
      const injectableSecrets = await injectableSecretWhere(
        agent,
        projectId,
        auth.organizationId,
      );

      // Detect auth mode from the agent's Anthropic secret metadata. OAuth
      // tokens need CLAUDE_CODE_OAUTH_TOKEN so the SDK does the token exchange;
      // API keys need ANTHROPIC_API_KEY. Defaults to api-key for legacy secrets
      // without metadata.
      const anthropicSecret = await findInjectableSecretOfType(
        injectableSecrets,
        "anthropic",
        { metadata: true, encryptedValue: true },
      );

      const meta = parseAnthropicMetadata(anthropicSecret?.metadata);

      const authEnv: Record<string, string> =
        meta?.authMode === "oauth"
          ? { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" }
          : { ANTHROPIC_API_KEY: "placeholder" };

      // Detect OpenAI auth mode for Codex container support.
      const openaiSecret = await findInjectableSecretOfType(
        injectableSecrets,
        "openai",
        { metadata: true },
      );

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
            content: buildCodexOAuthStub(),
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
      } else if (anthropicSecret.encryptedValue) {
        // 1Password-sourced secrets have no stored value to decrypt — the
        // gateway resolves them live, so the decryptability check doesn't apply.
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
