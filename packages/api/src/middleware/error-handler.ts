import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ServiceError, type ServiceErrorCode } from "../services/errors";
import { ChannelProviderApiError } from "../services/channels/errors";
import { channelProvider } from "../services/channels/registry";
import { logger } from "../lib/logger";

const STATUS_MAP = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  UNPROCESSABLE: 422,
  CONFLICT: 409,
  FORBIDDEN: 403,
  GONE: 410,
  RATE_LIMITED: 429,
} as const satisfies Record<ServiceErrorCode, ContentfulStatusCode>;

const ERROR_TYPE_MAP: Record<ServiceErrorCode, string> = {
  NOT_FOUND: "not_found_error",
  BAD_REQUEST: "invalid_request_error",
  UNPROCESSABLE: "validation_error",
  CONFLICT: "invalid_request_error",
  FORBIDDEN: "authentication_error",
  GONE: "invalid_request_error",
  RATE_LIMITED: "rate_limit_error",
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
  // A channel provider's API refusal reaching here is a bad-input outcome the
  // user can act on (an expired token, `managed_app_limit_reached`, …), not a
  // server bug — surface the provider's own code as a 422 rather than a blank
  // 500. The plan requires these codes reach the user verbatim. Branches on
  // the neutral base class; the provider's display name comes from the
  // registry, so nothing Slack-shaped is imported here.
  if (err instanceof ChannelProviderApiError) {
    return c.json(
      {
        error: {
          message: `${channelProvider(err.providerId).displayName} rejected the request (${err.code}).`,
          type: "validation_error",
        },
      },
      422,
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
