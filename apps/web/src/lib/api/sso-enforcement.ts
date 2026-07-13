import { apiGet, apiPatch } from "./client";
import type { OrgSsoEnforcement } from "./types";

// Organization-scoped only — the require-SSO login policy.
const base = "/v1/org/sso/enforcement";

export const get = () => apiGet<OrgSsoEnforcement>(base);

export const update = (ssoRequired: boolean) =>
  apiPatch<OrgSsoEnforcement>(base, { ssoRequired });
