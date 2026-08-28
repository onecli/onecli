"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";

interface SlackInstalledSignInProps {
  callbackUrl: string;
}

/**
 * The signed-out arm of a Slack-directory install. Parks the return URL in
 * the post-auth callback channel (`postAuthCallbackUrl`, consumed by
 * `resolveHomeRedirect` and the login page) so the code survives whichever
 * login the deployment runs — Cognito's hosted screen included, which cannot
 * carry a `next=` param of ours. Deliberately NOT `inviteCallbackUrl`: that
 * channel suppresses the new-user org bootstrap (an invitee joins someone
 * else's org), while a directory installer signing UP needs their org
 * bootstrapped to have anywhere to bind the install.
 */
export const SlackInstalledSignIn = ({
  callbackUrl,
}: SlackInstalledSignInProps) => {
  const router = useRouter();

  const handleSignIn = () => {
    localStorage.setItem("postAuthCallbackUrl", callbackUrl);
    router.push("/auth/login");
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
        <h1 className="text-center text-sm font-medium">
          OneCLI was added to your Slack workspace
        </h1>
        <p className="text-muted-foreground mt-2 text-center text-sm">
          Sign in or create an account to finish connecting it.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <Button onClick={handleSignIn}>Sign in to continue</Button>
        </div>
      </Card>
    </div>
  );
};
