"use client";

import { useRouter } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { BrandLogo } from "@/lib/components/brand-logo";

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
      <BrandLogo />

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
