import Image from "next/image";
import Link from "next/link";
import { MailX } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import type { UnavailableInvitationReason } from "@onecli/api/services/invitation-service";
import { JoinResumeSignIn } from "./join-resume-sign-in";

interface JoinUnavailableProps {
  reason: UnavailableInvitationReason;
  signedIn: boolean;
  /** This very join link, for a signed-out accepter to come back to. */
  callbackUrl: string;
}

const COPY: Record<
  UnavailableInvitationReason,
  { title: string; description: string }
> = {
  expired: {
    title: "This invitation has expired",
    description:
      "Invitations are valid for 7 days. Ask an admin of the organization to send you a new one.",
  },
  accepted: {
    title: "This invitation was already used",
    description:
      "If that was you, sign in to open the organization. Otherwise it can't be used again: if you were removed from the organization, ask an admin to invite you again.",
  },
  cancelled: {
    title: "This invitation was cancelled",
    description:
      "An admin withdrew it. Ask them to send you a new invitation if you should still have access.",
  },
  unknown: {
    title: "This invitation link isn't valid",
    description:
      "The link may be incomplete or was copied incorrectly. Open it again from the invitation email, or ask for a new one.",
  },
};

/**
 * A join link that cannot be redeemed, explained.
 *
 * Replaces the old silent `?error=invitation_invalid` redirect, which
 * nothing rendered: people saw the dashboard or the login form and had no
 * idea whether the link was broken, stale, or already used.
 *
 * One case is not a dead end: a USED link, seen signed out, is most often
 * its own accepter re-clicking the email on a new device. The page cannot
 * tell that without a session, so "Sign in" there comes back to this link —
 * the re-click redirect on /join then takes them into the organization.
 * The other reasons would only show this same screen again, so they sign in
 * plainly.
 */
export const JoinUnavailable = ({
  reason,
  signedIn,
  callbackUrl,
}: JoinUnavailableProps) => {
  const { title, description } = COPY[reason];
  const resumes = !signedIn && reason === "accepted";
  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-4">
      <div className="mb-8">
        <Image
          src="/onecli-full-logo.png"
          alt="OneCLI"
          width={140}
          height={40}
          priority
          className="dark:hidden"
        />
        <Image
          src="/onecli-full-logo-dark.png"
          alt="OneCLI"
          width={140}
          height={40}
          priority
          className="hidden dark:block"
        />
      </div>

      <Card className="w-full max-w-md p-8">
        <div className="flex flex-col items-center space-y-4 text-center">
          <MailX className="text-muted-foreground size-8" />
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>

        <div className="mt-8 flex items-center justify-center">
          {resumes ? (
            <JoinResumeSignIn callbackUrl={callbackUrl} />
          ) : (
            <Button asChild>
              <Link href={signedIn ? "/" : "/auth/login"}>
                {signedIn ? "Go to dashboard" : "Sign in"}
              </Link>
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};
