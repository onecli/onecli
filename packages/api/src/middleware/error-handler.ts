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

const ERROR_TYPE_MAP: Record<ServiceErrorCode, string> = {
  NOT_FOUND: "not_found_error",
  BAD_REQUEST: "invalid_request_error",
  CONFLICT: "invalid_request_error",
  FORBIDDEN: "authentication_error",
};

const DOCS_URL = "https://onecli.sh/docs/api-reference";

export const apiError = (
  message: string,
  type: string = "invalid_request_error",
) => ({
  error: { message, type },
});

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ServiceError) {
    return c.json(
      {
        error: {
          message: err.message,
          type: ERROR_TYPE_MAP[err.code] ?? "api_error",
        },
      },
      STATUS_MAP[err.code] ?? (500 as const),
    );
  }
  logger.error({ err }, "unhandled api error");
  return c.json(
    {
      error: {
        message: "An unexpected error occurred.",
        type: "api_error",
      },
    },
    500,
  );
};

export const notFoundHandler = (c: Parameters<ErrorHandler>[1]) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  return c.json(
    {
      error: {
        message: `Unrecognized request URL (${method}: ${path}). Please see ${DOCS_URL} for available endpoints.`,
        type: "invalid_request_error",
      },
    },
    404,
  );
};
