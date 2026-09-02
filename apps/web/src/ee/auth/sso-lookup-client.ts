import { apiFetch } from "@/lib/api-fetch";

export interface SsoLookupResult {
  sso: boolean;
  provider?: string;
  /** The domain's org REQUIRES SSO — no OTP fallback for these emails. */
  enforced?: boolean;
}

/**
 * Cheap client-side sanity check before hitting the HRD lookup — deliberately
 * lax (just an `@` and a `.`), not RFC validation. The server is the real gate.
 */
export const isPlausibleEmail = (email: string): boolean =>
  email.includes("@") && email.includes(".");

/**
 * Home-realm discovery call shared by the login page and the direct SSO
 * entry. Null means the lookup itself failed (outage/network) — callers
 * fail open into their non-SSO flow; `{ sso: false }` is a real answer.
 */
export const lookupSsoProvider = async (
  email: string,
): Promise<SsoLookupResult | null> =>
  apiFetch("/v1/auth/sso/lookup", {
    method: "POST",
    body: JSON.stringify({ email }),
  })
    .then((res) => (res.ok ? (res.json() as Promise<SsoLookupResult>) : null))
    .catch(() => null);
