import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ServiceError, type ServiceErrorCode } from "../services/errors";
import { logger } from "../lib/logger";

const STATUS_MAP = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  FORBIDDEN: 403,
} as const satisfies Record<ServiceErrorCode, ContentfulStatusCode>;

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ServiceError) {
    return c.json(
      { error: err.message },
      STATUS_MAP[err.code] ?? (500 as const),
    );
  }
  logger.error({ err }, "unhandled api error");
  return c.json({ error: "Internal server error" }, 500);
};
