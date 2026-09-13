"use client";

import { useRouter } from "next/navigation";
import { Button } from "@onecli/ui/components/button";

interface JoinResumeSignInProps {
  callbackUrl: string;
}

/**
 * "Sign in" that comes BACK to this join link afterwards.
 *
 * For a used link this is the difference between landing on the dashboard
 * and landing in the organization: the person who accepted it, re-clicking
 * the email while signed out, is answered by the re-click redirect on /join
 * — but only once they are signed in and the page runs again. Parking the URL
 * in `inviteCallbackUrl` is what brings them back here; the login screen's
 * post-auth sync resumes from that slot (both editions already do).
 */
export const JoinResumeSignIn = ({ callbackUrl }: JoinResumeSignInProps) => {
  const router = useRouter();

  const handleSignIn = () => {
    localStorage.setItem("inviteCallbackUrl", callbackUrl);
    router.push("/auth/login");
  };

  return <Button onClick={handleSignIn}>Sign in</Button>;
};
