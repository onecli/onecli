import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { parseOpenaiMetadata } from "../validations/secret";
import { buildCodexOAuthStub, CODEX_APIKEY_STUB } from "../lib/codex-stubs";

const resolveCodexStub = async (projectId: string, organizationId: string) => {
  const openaiSecrets = await db.secret.findMany({
    where: {
      type: "openai",
      OR: [{ projectId }, { organizationId }],
    },
    select: { metadata: true },
    take: 10,
  });

  // If ALL OpenAI secrets are api-key mode, use the api-key stub.
  // Otherwise default to OAuth (covers: no secrets, mixed, or all oauth).
  const hasAny = openaiSecrets.length > 0;
  const allApiKey =
    hasAny &&
    openaiSecrets.every(
      (s) => parseOpenaiMetadata(s.metadata)?.authMode === "api-key",
    );

  return {
    agent: "codex",
    filePath: "~/.codex/auth.json",
    content: allApiKey ? CODEX_APIKEY_STUB : buildCodexOAuthStub(),
    authMode: allApiKey ? "api-key" : "oauth",
    permissions: "0600",
  };
};

export const credentialStubRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // GET /credential-stubs/:agent
  app.get("/:agent", async (c) => {
    const agent = c.req.param("agent");
    if (agent !== "codex") {
      return c.json({ error: `No credential stub for agent "${agent}"` }, 404);
    }
    const auth = c.get("auth");
    const stub = await resolveCodexStub(
      requireProjectId(auth),
      auth.organizationId,
    );
    return c.json(stub);
  });

  // GET /credential-stubs — list available agents
  app.get("/", (c) => {
    return c.json({ agents: ["codex"] });
  });

  return app;
};
