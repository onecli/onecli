"use client";

import { useState } from "react";
import Image from "next/image";
import { LogOut } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useAuth } from "@/providers/auth-provider";

interface JoinWrongAccountProps {
  orgName: string;
  invitedEmail: string;
  currentEmail: string;
  callbackUrl: string;
}

/**
 * Signed in, but not as the person the invitation was sent to.
 *
 * Pressing "Join" here would only bounce off the accept route's email check,
 * so say what is going on and offer the one action that helps: sign out, then
 * come back to this very link as the invited account. The join URL is parked
 * in `inviteCallbackUrl`, the same slot the login screen already resumes
 * from after a fresh sign-in, so redeeming continues where it left off.
 */
export const JoinWrongAccount = ({
  orgName,
  invitedEmail,
  currentEmail,
  callbackUrl,
}: JoinWrongAccountProps) => {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleSwitch = async () => {
    setSigningOut(true);
    localStorage.setItem("inviteCallbackUrl", callbackUrl);
    try {
      await signOut();
    } catch {
      setSigningOut(false);
    }
  };

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
        <div className="space-y-4 text-center">
          <p className="text-muted-foreground text-sm">
            You have been invited to join
          </p>
          <h1 className="text-2xl font-semibold">{orgName}</h1>
          <p className="text-muted-foreground text-sm">
            This invitation was sent to{" "}
            <span className="text-foreground font-medium">{invitedEmail}</span>,
            but you are signed in as{" "}
            <span className="text-foreground font-medium">{currentEmail}</span>.
            Switch accounts to accept it.
          </p>
        </div>

        <div className="mt-8 flex items-center justify-center">
          <Button onClick={handleSwitch} disabled={signingOut}>
            <LogOut className="size-4" />
            {signingOut
              ? "Signing out…"
              : `Sign out and continue as ${invitedEmail}`}
          </Button>
        </div>
      </Card>
    </div>
  );
};
