import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { parseOpenaiMetadata } from "../validations/secret";
import { buildCodexOAuthStub, CODEX_APIKEY_STUB } from "../lib/codex-stubs";

const resolveCodexStub = async (
  workspaceId: string,
  organizationId: string,
) => {
  const openaiSecrets = await db.secret.findMany({
    where: {
      type: "openai",
      OR: [{ workspaceId }, { organizationId }],
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

  // The stub carries one ChatGPT account id and plan. Use each only when every
  // OAuth secret agrees on it; otherwise we can't know which one the gateway
  // will inject, so keep the placeholder account and leave the plan out.
  const oauthMetas = openaiSecrets
    .map((s) => parseOpenaiMetadata(s.metadata))
    .filter((m) => m?.authMode === "oauth");
  const agreed = (values: Array<string | undefined>) => {
    const unique = new Set(values);
    const [only] = unique;
    return unique.size === 1 ? only : undefined;
  };
  const accountId = agreed(oauthMetas.map((m) => m?.accountId));
  const planType = agreed(oauthMetas.map((m) => m?.planType));

  return {
    agent: "codex",
    filePath: "~/.codex/auth.json",
    content: allApiKey
      ? CODEX_APIKEY_STUB
      : buildCodexOAuthStub({ accountId, planType }),
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
      requireWorkspaceId(auth),
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
