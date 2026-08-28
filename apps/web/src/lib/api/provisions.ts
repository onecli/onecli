import { apiPost } from "./client";

// Provision claim links (EE member provisioning). Only redemption lives in
// the web client: provisions are minted via the API (POST /v1/team/provisions)
// and have no dashboard surface. Claiming deliberately is not org-scoped —
// the person claiming is not a member yet.
export const claim = (token: string) =>
  apiPost<{ organizationId: string; organizationName: string }>(
    "/v1/provisions/claim",
    { token },
  );
