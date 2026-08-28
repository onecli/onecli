"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";

interface JoinSignInProps {
  callbackUrl: string;
}

export const JoinSignIn = ({ callbackUrl }: JoinSignInProps) => {
  const router = useRouter();

  const handleSignIn = () => {
    localStorage.setItem("inviteCallbackUrl", callbackUrl);
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
        <p className="text-center text-sm font-medium">
          Sign in or create an account first to view this invitation
        </p>
        <div className="mt-6 flex items-center justify-center">
          <Button onClick={handleSignIn}>Sign in</Button>
        </div>
      </Card>
    </div>
  );
};
