"use client";

import { useRouter } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { ClaimHero } from "./claim-hero";

interface ClaimSignInProps {
  callbackUrl: string;
}

export const ClaimSignIn = ({ callbackUrl }: ClaimSignInProps) => {
  const router = useRouter();

  const handleSignIn = () => {
    localStorage.setItem("claimCallbackUrl", callbackUrl);
    router.push("/auth/login");
  };

  return (
    <ClaimHero
      title="Claim your workspace"
      subtitle="Sign in or create an account to get started."
    >
      <Button size="lg" className="w-full" onClick={handleSignIn}>
        Sign in
      </Button>
    </ClaimHero>
  );
};
