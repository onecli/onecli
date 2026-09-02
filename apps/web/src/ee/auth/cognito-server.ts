import { cookies } from "next/headers";
import { createServerRunner } from "@aws-amplify/adapter-nextjs";
import { fetchAuthSession, getCurrentUser } from "aws-amplify/auth/server";
import { parseCognitoIdentityClaims } from "@onecli/api/ee/auth/cognito-identity";
import type { AuthUser } from "@/lib/auth/types";
import { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } from "@/lib/env";

const { runWithAmplifyServerContext } = createServerRunner({
  config: {
    Auth: {
      Cognito: {
        userPoolId: COGNITO_USER_POOL_ID!,
        userPoolClientId: COGNITO_CLIENT_ID!,
      },
    },
  },
});

export const getServerSessionImpl = async (): Promise<AuthUser | null> => {
  try {
    const currentUser = await runWithAmplifyServerContext({
      nextServerContext: { cookies: () => cookies() },
      operation: (contextSpec) => getCurrentUser(contextSpec),
    });
    const session = await runWithAmplifyServerContext({
      nextServerContext: { cookies: () => cookies() },
      operation: (contextSpec) => fetchAuthSession(contextSpec),
    });

    const idToken = (
      session as {
        tokens?: { idToken?: { payload?: Record<string, unknown> } };
      }
    ).tokens?.idToken;

    const payload = idToken?.payload;
    const { identityProviders, federatedProvider, emailVerified } =
      parseCognitoIdentityClaims(payload ?? {});

    return {
      id: currentUser.userId,
      email: (payload?.email as string) ?? "",
      name: payload?.name as string | undefined,
      emailVerified,
      federatedProvider,
      identityProviders,
    };
  } catch {
    return null;
  }
};
