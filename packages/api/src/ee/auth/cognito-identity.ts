/**
 * Cognito ID-token identity claims → session fields. The single parse used
 * by BOTH session providers (api-server JWT path and the web Amplify server
 * path) so trust-relevant derivation can never drift between them.
 */

export interface CognitoIdentityClaims {
  /** ALL federated provider names on the profile, in token order. */
  identityProviders: string[];
  /** First entry, kept for back-compat display; trust code scans the array. */
  federatedProvider: string | null;
  emailVerified: boolean;
}

/**
 * Reads `identities` (the federated-provider list) and `email_verified` off a
 * decoded Cognito ID-token payload. Typed as an open record so both the jose
 * `JWTPayload` (api-server) and the Amplify token payload (web) pass without a
 * cast — every field is accessed as `unknown` and narrowed here.
 */
export const parseCognitoIdentityClaims = (
  payload: Record<string, unknown>,
): CognitoIdentityClaims => {
  const identities = payload.identities;
  const identityProviders = Array.isArray(identities)
    ? identities.flatMap((entry) => {
        const name = (entry as { providerName?: unknown }).providerName;
        return typeof name === "string" && name.length > 0 ? [name] : [];
      })
    : [];
  return {
    identityProviders,
    federatedProvider: identityProviders[0] ?? null,
    emailVerified:
      payload.email_verified === true || payload.email_verified === "true",
  };
};
