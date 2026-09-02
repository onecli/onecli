import { Amplify } from "aws-amplify";
import {
  COGNITO_CLIENT_ID,
  COGNITO_DOMAIN,
  COGNITO_USER_POOL_ID,
} from "@/lib/env";

export const configureAmplify = () => {
  Amplify.configure(
    {
      Auth: {
        Cognito: {
          userPoolId: COGNITO_USER_POOL_ID!,
          userPoolClientId: COGNITO_CLIENT_ID!,
          loginWith: {
            oauth: {
              domain: COGNITO_DOMAIN!,
              scopes: ["openid", "email", "profile"],
              redirectSignIn: [window.location.origin],
              redirectSignOut: [window.location.origin],
              responseType: "code",
            },
            email: true,
          },
        },
      },
    },
    { ssr: true },
  );
};
