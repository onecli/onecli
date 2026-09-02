import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SCIM_CONTENT_TYPE } from "./serialization";
import { ScimError } from "./errors";

/**
 * The ONLY response constructor in the SCIM module: every dialect response —
 * success, protocol error, 401, 404, 500 — must carry
 * `Content-Type: application/scim+json` (RFC 7644 §3.1; both Entra and Okta
 * send/expect it). Never use `c.json` here — it stamps application/json.
 * (204s are the one exception: no body, no content type.)
 */
export const scimJson = (
  c: Context,
  body: unknown,
  status: ContentfulStatusCode,
  headers?: Record<string, string>,
): Response =>
  c.body(JSON.stringify(body), status, {
    "Content-Type": SCIM_CONTENT_TYPE,
    ...headers,
  });

/**
 * Single-resource response: RFC 7643 §3.1 pins `meta.location` to the
 * Content-Location header, and creations additionally carry Location
 * (RFC 7644 §3.3).
 */
export const scimResource = (
  c: Context,
  body: { meta: { location: string } },
  status: 200 | 201 = 200,
): Response =>
  scimJson(c, body, status, {
    "Content-Location": body.meta.location,
    ...(status === 201 ? { Location: body.meta.location } : {}),
  });

/** Request-body parse with a SCIM-shaped 400 instead of an opaque 500. */
export const readScimBody = async (
  c: Context,
): Promise<Record<string, unknown>> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ScimError(
      400,
      "Request body must be valid JSON.",
      "invalidSyntax",
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ScimError(
      400,
      "Request body must be an object.",
      "invalidSyntax",
    );
  }
  return body as Record<string, unknown>;
};
