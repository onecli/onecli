import { createRemoteJWKSet, jwtVerify } from "jose";
import type { SessionProvider } from "@onecli/api";
import { parseCognitoIdentityClaims } from "@onecli/api/ee/auth/cognito-identity";
import { logger } from "./logger";

const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const COGNITO_ISSUER = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`;

const jwks = createRemoteJWKSet(
  new URL(`${COGNITO_ISSUER}/.well-known/jwks.json`),
);

export const cognitoSessionProvider: SessionProvider = {
  getSession: async (request: Request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7);

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: COGNITO_ISSUER,
      });

      if (!payload.sub) return null;

      const { identityProviders, federatedProvider, emailVerified } =
        parseCognitoIdentityClaims(payload);

      return {
        id: payload.sub,
        email: (payload.email as string) ?? "",
        name: (payload.name as string) || (payload.email as string),
        emailVerified,
        federatedProvider,
        identityProviders,
      };
    } catch (err) {
      logger.debug({ err }, "JWT verification failed");
      return null;
    }
  },
};
