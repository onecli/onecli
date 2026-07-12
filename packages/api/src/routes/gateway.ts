import { Hono } from "hono";
import { GATEWAY_API_URL } from "../lib/env";
import { loadCaCertificate } from "../lib/gateway-ca";

// Public discovery endpoint — no auth, mirroring the `/gateway/ca` sibling
// below. It returns only the deployment's gateway proxy URL: a static,
// per-deployment config value (identical for every caller, not a secret) that
// clients need to bootstrap BEFORE they hold a project or org context. Guarding
// it with the project-requiring auth middleware 401'd onprem-slim clients, whose
// only credential at discovery time is an org key carrying no project.
export const gatewayUrlRoutes = () => {
  const app = new Hono();

  app.get("/", (c) => c.json({ url: GATEWAY_API_URL }));

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
