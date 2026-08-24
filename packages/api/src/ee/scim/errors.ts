import { ServiceError, type ServiceErrorCode } from "../../services/errors";

/**
 * SCIM protocol errors (RFC 7644 §3.12): the urn:...:Error schema with a
 * STRING `status` (verified against Entra's own examples — `"status": "404"`)
 * and an optional `scimType` keyword. IdP admin consoles surface `detail`
 * verbatim, so write it for the customer's IT admin, not for us.
 */

export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export type ScimErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 501;

export type ScimType =
  | "uniqueness"
  | "invalidFilter"
  | "invalidValue"
  | "invalidSyntax"
  | "invalidPath"
  | "mutability"
  | "noTarget";

export interface ScimErrorBody {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string;
  detail: string;
  scimType?: ScimType;
}

export class ScimError extends Error {
  readonly status: ScimErrorStatus;
  readonly scimType?: ScimType;

  constructor(status: ScimErrorStatus, detail: string, scimType?: ScimType) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
  }
}

export const scimErrorBody = (
  status: ScimErrorStatus,
  detail: string,
  scimType?: ScimType,
): ScimErrorBody => ({
  schemas: [SCIM_ERROR_SCHEMA],
  status: String(status),
  detail,
  ...(scimType ? { scimType } : {}),
});

const SERVICE_ERROR_MAP: Record<
  ServiceErrorCode,
  { status: ScimErrorStatus; scimType?: ScimType }
> = {
  // 409 + uniqueness is load-bearing: Okta halts provisioning on it and
  // shows `detail` in its admin console.
  CONFLICT: { status: 409, scimType: "uniqueness" },
  NOT_FOUND: { status: 404 },
  // Guard rejections (e.g. "the organization owner cannot be suspended")
  // must be a 400 the IdP displays, never a 500.
  BAD_REQUEST: { status: 400, scimType: "invalidValue" },
  // Not thrown on the SCIM path (policy validation is app-only); mapped for
  // exhaustiveness — SCIM expresses validation failures as 400 invalidValue.
  UNPROCESSABLE: { status: 400, scimType: "invalidValue" },
  FORBIDDEN: { status: 403 },
  // Not thrown on the SCIM path (GONE is the legacy policy-rules deprecation);
  // mapped for exhaustiveness — SCIM has no 410, so express it as a 400.
  GONE: { status: 400, scimType: "invalidValue" },
  // Not thrown on the SCIM path (RATE_LIMITED is the SSH cert-mint budget);
  // mapped for exhaustiveness — SCIM's error status set has no 429.
  RATE_LIMITED: { status: 400, scimType: "invalidValue" },
};

/** Domain ServiceError → the SCIM wire error; anything else stays as-is. */
export const toScimError = (err: unknown): ScimError | null => {
  if (err instanceof ScimError) return err;
  if (err instanceof ServiceError) {
    const mapped = SERVICE_ERROR_MAP[err.code];
    return new ScimError(mapped.status, err.message, mapped.scimType);
  }
  return null;
};
