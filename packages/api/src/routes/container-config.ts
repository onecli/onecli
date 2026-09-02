import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import {
  buildContainerConfig,
  resolveContainerConfigAgent,
} from "../services/container-config-service";
import { logger } from "../lib/logger";

/**
 * The payload assembly and the agent resolution live in
 * `services/container-config-service.ts` so the runner plane can compose spawn
 * payloads server-side (§5.1) and the resolution semantics can be proven on
 * real Postgres — this route is the user-facing wrapper that maps resolution
 * outcomes to HTTP. The helper re-exports keep the historical import surface
 * of this module stable.
 */
export {
  injectableSecretWhere,
  findInjectableSecretOfType,
} from "../services/container-config-service";

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
      const workspaceId = requireWorkspaceId(auth);

      const agentIdentifier = c.req.query("agent");

      // Omitting `agent=` is the LEGACY arm: pre-v2 workspaces carry a
      // deprecated default agent (`Agent.isDefault`, never written anymore)
      // and their already-configured unpinned machines keep resolving it.
      // Everyone else must name an agent — pass `agent=` or pin the machine
      // (`onecli config set agent`). Nothing is invented here: this route
      // used to auto-create a "Default Agent", handing out a live proxy token
      // nobody asked for.
      const resolution = await resolveContainerConfigAgent(
        workspaceId,
        agentIdentifier,
      );

      if (resolution.outcome === "identifier-not-found") {
        // Fail loud: a container was started for an agent that isn't
        // registered (its POST /v1/agents create was rejected or never ran).
        // Without this it manifests as a silent hang -- the container boots,
        // never wires credentials, and never replies. Log it server-side and
        // return an actionable, machine-detectable error so it's traceable.
        logger.warn(
          { workspaceId, agentIdentifier, route: "GET /v1/container-config" },
          "container config requested for unregistered agent identifier",
        );
        return c.json(
          {
            error: `No agent with identifier "${agentIdentifier}" exists in this workspace. Create it first via POST /v1/agents.`,
            code: "AGENT_NOT_FOUND",
            agentIdentifier,
          },
          404,
        );
      }

      if (resolution.outcome === "no-legacy-default") {
        if (resolution.hasAgents) {
          // Agents exist but none is the legacy default: the caller has to
          // choose. This is every post-v2 workspace — omission stopped meaning
          // anything the day seeding and set-default died.
          logger.warn(
            { workspaceId, route: "GET /v1/container-config" },
            "container config requested without an agent and no legacy default exists",
          );
          return c.json(
            {
              error:
                'No agent specified and this workspace has no default agent. Pass the "agent" query parameter, or pin this machine with `onecli config set agent <identifier>`.',
              code: "AGENT_REQUIRED",
            },
            404,
          );
        }
        // A workspace with no agents is a normal starting state now (nothing is
        // seeded), so say so instead of inventing one: this route used to
        // create a "Default Agent" here, which handed out a token nobody asked
        // for and left every install with an agent it had to keep.
        logger.warn(
          { workspaceId, route: "GET /v1/container-config" },
          "container config requested for a workspace with no agents",
        );
        return c.json(
          {
            error:
              "This workspace has no agents yet. Create one in the dashboard, then run this again.",
            code: "NO_AGENTS",
          },
          404,
        );
      }

      const result = await buildContainerConfig({
        agent: resolution.agent,
        workspaceId,
        organizationId: auth.organizationId,
        origin: c.req.header("origin"),
      });

      if (!result.ok) {
        return c.json(
          {
            error:
              "CA certificate not available. Start the gateway first to generate it.",
          },
          503,
        );
      }

      return c.json(result.config);
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
