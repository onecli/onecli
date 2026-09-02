import { createMiddleware } from "hono/factory";
import pino from "pino";
import type { AuthContext } from "@onecli/api";

const SLOW_THRESHOLD_MS = 3000;

const requestLog = pino({
  level: "info",
  ...(process.env.NODE_ENV === "production"
    ? {}
    : { transport: { target: "pino-pretty" } }),
});

export const requestLogger = createMiddleware(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.header("X-Request-Id", requestId);

  const start = performance.now();
  await next();
  const ms = Math.round(performance.now() - start);

  if (c.req.path === "/v1/health") return;

  const auth = c.var.auth as AuthContext | undefined;
  const level: pino.Level = ms > SLOW_THRESHOLD_MS ? "warn" : "info";

  requestLog[level](
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms,
      orgId: auth?.organizationId,
    },
    "request",
  );
});
