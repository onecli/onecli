import type { SessionUser } from "../providers/types";

/**
 * The federated provider worth recording on the user row, from a session.
 *
 * Only Google is recorded: it is the one provider the cloud platform trial
 * credit trusts whatever the address (`ee/platform_llm.rs`), because a Google
 * account is not something a signup farm can mint by the hundred. A session
 * that carries Google anywhere in its identities counts, so a profile linked
 * to several providers is not misread by token order.
 *
 * Returns `undefined` (leave the stored value alone) for a native or
 * non-Google session rather than `null`: an email-code login by someone who
 * also signs in with Google must not erase what an earlier Google login
 * proved.
 */
export const recordableSignInProvider = (
  session: Pick<SessionUser, "federatedProvider" | "identityProviders">,
): "Google" | undefined => {
  const providers = [
    ...(session.identityProviders ?? []),
    ...(session.federatedProvider ? [session.federatedProvider] : []),
  ];
  return providers.includes("Google") ? "Google" : undefined;
};
