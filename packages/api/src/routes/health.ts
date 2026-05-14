import { Hono } from "hono";

export const healthRoutes = (version?: string) => {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      status: "ok",
      version: version ?? "unknown",
      timestamp: new Date().toISOString(),
    }),
  );

  return app;
};
