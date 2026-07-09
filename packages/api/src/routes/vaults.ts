import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware, requireProjectId } from "../middleware/auth";
import { listVaultConnections } from "../services/vault-service";

// Read-only: vault pairing/status/disconnect live on the gateway process
// (/v1/vault/* there) — only the dashboard list view is served here.
export const vaultRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  // ── GET /vaults ── list external vault connections ─────────────────────
  app.get("/", async (c) => {
    const auth = c.get("auth");
    return c.json(await listVaultConnections(requireProjectId(auth)));
  });

  return app;
};
