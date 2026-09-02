import { adoptLegacyInstall } from "./legacy-adoption";
import type { SessionHooks } from "../routes/auth-session";

/**
 * Session-sync policy for the self-hosted edition.
 *
 * The identity layer (better-auth) creates the user row itself, during the
 * sign-in callback, so by the time `GET /v1/auth/session` runs the row always
 * pre-exists. Keeping the default "only bootstrap a user this request
 * created" would therefore mean self-hosted users are NEVER given an
 * organization — and, worse, that a signup whose provisioning failed halfway
 * could never be repaired, because nothing would try again.
 *
 * Provisioning here is keyed on the state that actually matters: a user with
 * no organization gets one, on whichever request notices. That runs on every
 * session sync, so it is self-healing rather than one-shot.
 *
 * The upgrade path rides the same property. A deployment coming from the
 * pre-2.0 no-login mode hands its data to the account that just registered
 * (`legacy-adoption.ts`) — and because that happens BEFORE the identity is
 * resolved, the bootstrap below then finds an organization already there and
 * correctly declines to create a second one.
 */
export const onpremSessionHooks: Partial<SessionHooks> = {
  beforeIdentitySync: async (session) => {
    await adoptLegacyInstall(session.id);
  },
  // ...with one exception: someone arriving through an invitation is joining
  // an existing organization, not starting their own. Bootstrapping first
  // would hand them a personal org they never asked for and then drop them
  // into somebody else's — two organizations for one signup. The marker is
  // the same one cloud has always used.
  shouldBootstrapOrg: (request) =>
    !new URL(request.url).searchParams.get("fromInvitation"),
};
