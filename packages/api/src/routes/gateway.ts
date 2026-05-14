import { Hono } from "hono";
import type { ApiEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { API_URL } from "../lib/env";
import { loadCaCertificate } from "../lib/gateway-ca";

export const gatewayUrlRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/", (c) => c.json({ url: API_URL }));

  return app;
};

export const gatewayCaRoutes = () => {
  const app = new Hono();

  app.get("/ca", (c) => {
    const pem = loadCaCertificate();

    if (!pem) {
      return c.json(
        {
          error:
            "CA certificate not available. Start the gateway first to generate it.",
        },
        503,
      );
    }

    return c.body(pem, 200, {
      "content-type": "application/x-pem-file",
      "content-disposition": 'attachment; filename="onecli-gateway-ca.pem"',
    });
  });

  return app;
};
