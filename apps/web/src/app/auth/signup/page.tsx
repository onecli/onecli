import { redirect } from "next/navigation";
import { registrationState } from "@onecli/api/lib/registration";
import { findPendingInvitationByToken } from "@onecli/api/services/invitation-service";
import { logger } from "@onecli/api/lib/logger";
import { GOOGLE_CLIENT_ID, IS_CLOUD } from "@/lib/env";
import { SignupContent } from "./_components/signup-content";

/**
 * Creating an account. Registration is open on self-host — every account gets
 * its own organization — so this page is always reachable; the server only
 * decides which framing the visitor sees:
 *
 *  - **First run** — the instance has no account yet, and the one being
 *    created is its first (possibly adopting a pre-2.0 install's data).
 *  - **Invited** — this visitor holds an invitation and is joining an
 *    existing organization. Their email is fixed by that invitation, so the
 *    form shows it locked: registering under a different address would
 *    produce an account the invitation cannot be accepted by.
 *  - **Otherwise** — an ordinary signup that starts an organization of its
 *    own.
 *
 * Self-hosted only; cloud sign-up lives inside its Cognito login screen. If
 * the state cannot be read, the visitor is sent to the login screen, which
 * has its own failure copy.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  if (IS_CLOUD) redirect("/auth/login");

  const { token } = await searchParams;

  if (token) {
    const invitation = await findPendingInvitationByToken(token).catch(
      (err: unknown) => {
        logger.error({ err }, "could not resolve an invitation token");
        return null;
      },
    );
    if (!invitation) redirect("/auth/login?error=invitation_invalid");

    return (
      <SignupContent
        googleConfigured={Boolean(GOOGLE_CLIENT_ID)}
        firstAccount={false}
        adoptsExistingInstall={false}
        invitation={{
          token,
          email: invitation.email,
          organizationName: invitation.organizationName,
        }}
      />
    );
  }

  let state;
  try {
    state = await registrationState();
  } catch (err) {
    logger.error(
      { err },
      "could not read the deployment's account state — showing sign-in",
    );
    redirect("/auth/login");
  }

  return (
    <SignupContent
      googleConfigured={Boolean(GOOGLE_CLIENT_ID)}
      firstAccount={state.firstAccount}
      adoptsExistingInstall={state.adoptsExistingInstall}
    />
  );
}
