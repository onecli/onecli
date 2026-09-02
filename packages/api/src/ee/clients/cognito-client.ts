import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

// Region + credentials from the SDK default chain (task role), like the KMS
// and Secrets Manager clients. Retries are bounded so callers holding the
// Redis lock can compute a worst-case section time (lock TTL 60s >> this).
export const cognitoClient = new CognitoIdentityProviderClient({
  maxAttempts: 3,
});
