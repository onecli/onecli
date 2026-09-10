import { redirect } from "next/navigation";
import {
  explainUnavailableInvitation,
  findAcceptedInvitationOrgForUser,
  findPendingInvitationByToken,
} from "@onecli/api/services/invitation-service";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { IS_CLOUD } from "@/lib/env";
import { JoinForm } from "./_components/join-form";
import { JoinSignIn } from "./_components/join-sign-in";
import { JoinUnavailable } from "./_components/join-unavailable";
import { JoinWrongAccount } from "./_components/join-wrong-account";

/** `max@lizo.ai` → `m***@lizo.ai`: enough to recognise, not enough to harvest. */
const maskEmail = (email: string): string => {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
};

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

  const joinUrl = `/join?token=${encodeURIComponent(params.token)}`;

  // Two independent reads, issued together: the invitation behind the token,
  // and the account behind the session (when there is one). The join page
  // compares emails against the DB record rather than the raw session claim:
  // that is the address the accept route checks, so the screen and the route
  // agree.
  const [invitation, user] = await Promise.all([
    findPendingInvitationByToken(params.token),
    session
      ? db.user.findUnique({
          where: { externalAuthId: session.id },
          select: { id: true, email: true },
        })
      : null,
  ]);

  if (!invitation) {
    // The common non-pending case: the signed-in person already redeemed this
    // very link and clicked it again from the email. They are a member, so
    // take them into that organization instead of calling the link broken.
    if (user) {
      const orgId = await findAcceptedInvitationOrgForUser(
        params.token,
        user.id,
        user.email,
      );
      // The org layout pins the default-org cookie on arrival, so the
      // switch sticks across the rest of the session too.
      if (orgId) redirect(`/org/${orgId}/workspaces`);
    }

    // Expired, cancelled, used (by someone else, or by a since-removed
    // member), or simply not a real token. Say which, rather than rendering a
    // join button that cannot work or bouncing to a page that says nothing.
    const reason = await explainUnavailableInvitation(params.token);
    return (
      <JoinUnavailable
        reason={reason}
        signedIn={Boolean(session)}
        callbackUrl={joinUrl}
      />
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
    return <JoinSignIn callbackUrl={joinUrl} />;
  }

  // Signed in as someone the invitation was not addressed to (a second
  // account, a colleague's browser). "Join" would only be refused by the
  // accept route's email check, so offer the switch instead. The invited
  // address is masked: the link holder is by definition NOT that person, and
  // a forwarded link should not spell out someone else's email.
  const currentEmail = user?.email ?? session.email;
  if (
    currentEmail &&
    currentEmail.toLowerCase() !== invitation.email.toLowerCase()
  ) {
    return (
      <JoinWrongAccount
        orgName={invitation.organizationName}
        invitedEmail={maskEmail(invitation.email)}
        currentEmail={currentEmail}
        callbackUrl={joinUrl}
      />
    );
  }

  return (
    <JoinForm
      token={params.token}
      orgName={invitation.organizationName}
      orgSlug={invitation.organizationSlug}
    />
  );
}
