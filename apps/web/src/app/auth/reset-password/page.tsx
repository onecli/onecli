import { redirect } from "next/navigation";
import { IS_CLOUD } from "@/lib/env";
import { ResetPasswordContent } from "./_components/reset-password-content";

/**
 * Redeeming a password-reset link. Self-hosted only — cloud identities live in
 * Cognito, which owns its own recovery flow.
 */
export default function ResetPasswordPage() {
  if (IS_CLOUD) redirect("/auth/login");
  return <ResetPasswordContent />;
}
