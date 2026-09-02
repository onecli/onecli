import { redirect } from "next/navigation";
import { findPendingInvitationByToken } from "@onecli/api/services/invitation-service";
import { getServerSession } from "@/lib/auth/server";
import { IS_CLOUD } from "@/lib/env";
import { JoinForm } from "./_components/join-form";
import { JoinSignIn } from "./_components/join-sign-in";

/**
 * Redeeming an invitation.
 *
 * The invitation is resolved from the token server-side, not from the query
 * string. It used to take the organization's name and slug straight from the
 * URL, which meant a crafted `/join?name=…` could display any organization it
 * liked next to a real "You have been invited to join".
 *
 * Someone who is signed out is sent to SIGN UP rather than to sign in: on a
 * self-hosted deployment they usually have no account at all, and the signup
 * screen is the one that knows how to register against the invitation — it
 * locks the email to the invited address and joins them to the inviting
 * organization instead of starting one of their own.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const session = await getServerSession();
  const params = await searchParams;

  if (!params.token) {
    redirect(session ? "/" : "/auth/login");
  }

  const invitation = await findPendingInvitationByToken(params.token);

  // Expired, cancelled, already used, or simply not a real token. Say so on
  // the sign-in screen rather than rendering a join button that cannot work.
  if (!invitation) {
    redirect(
      session
        ? "/?error=invitation_invalid"
        : "/auth/login?error=invitation_invalid",
    );
  }

  if (!session) {
    // Self-host: this person almost certainly has no account — send them to
    // create one, with the invitation carried in the URL so registering joins
    // them to the inviting organization rather than starting their own.
    if (!IS_CLOUD) {
      redirect(`/auth/signup?token=${encodeURIComponent(params.token)}`);
    }
    // Cloud: Cognito owns sign-up inside its own login screen, so the token
    // rides localStorage across the redirect exactly as it always has.
    return <JoinSignIn callbackUrl={`/join?token=${params.token}`} />;
  }

  return (
    <JoinForm
      token={params.token}
      orgName={invitation.organizationName}
      orgSlug={invitation.organizationSlug}
    />
  );
}
