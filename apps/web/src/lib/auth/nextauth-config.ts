import NextAuth, { type DefaultSession } from "next-auth";
import type { Provider } from "next-auth/providers";
import {
  OAUTH_ISSUER,
  OAUTH_JWKS_URL,
  OAUTH_AUTHORIZATION_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  NEXTAUTH_SECRET,
} from "@/lib/env";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

const oidcProvider: Provider = {
  id: "oidc",
  name: "SSO",
  type: "oidc",
  issuer: OAUTH_ISSUER,
  clientId: OAUTH_CLIENT_ID,
  clientSecret: OAUTH_CLIENT_SECRET,
  ...(OAUTH_AUTHORIZATION_URL
    ? { authorization: OAUTH_AUTHORIZATION_URL }
    : {}),
  ...(OAUTH_TOKEN_URL ? { token: OAUTH_TOKEN_URL } : {}),
  ...(OAUTH_USERINFO_URL ? { userinfo: OAUTH_USERINFO_URL } : {}),
  ...(OAUTH_JWKS_URL ? { jwks_endpoint: OAUTH_JWKS_URL } : {}),
};

export const { auth, handlers } = NextAuth({
  providers: OAUTH_CLIENT_ID ? [oidcProvider] : [],
  session: { strategy: "jwt" },
  secret: NEXTAUTH_SECRET,
  pages: {
    signIn: "/auth/login",
  },
  callbacks: {
    jwt({ token, account }) {
      if (account) {
        token.authId = account.providerAccountId;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.authId as string;
      }
      return session;
    },
  },
});
