import { redirect } from "next/navigation";
import { isEmailConfigured } from "@onecli/api/services/email-service";
import { IS_CLOUD } from "@/lib/env";
import { ForgotPasswordContent } from "./_components/forgot-password-content";

/**
 * Requesting a password-reset link. Self-hosted only, and only where email can
 * actually be sent — a deployment with no provider would take the request and
 * silently do nothing, which is worse than not offering it.
 */
export default function ForgotPasswordPage() {
  if (IS_CLOUD || !isEmailConfigured()) redirect("/auth/login");
  return <ForgotPasswordContent />;
}
