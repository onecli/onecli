import { redirect } from "next/navigation";
import { isEntitled } from "@onecli/api/lib/entitlements";
import { SsoLoginContent } from "@/ee/auth/sso-login-content";

export default function Page() {
  // SSO (#74) is licensed. Unlicensed deployments have no SSO to look up,
  // so the entry point sends the visitor to the regular login instead of
  // rendering a form whose lookup can only 403.
  if (!isEntitled()) {
    redirect("/auth/login");
  }
  return <SsoLoginContent />;
}
