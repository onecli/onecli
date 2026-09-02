import { redirect } from "next/navigation";
import { findPendingProvisionByToken } from "@onecli/api/ee/services/user-provision-service";
import { getServerSession } from "@/lib/auth/server";
import { ClaimForm } from "./_components/claim-form";
import { ClaimSignIn } from "./_components/claim-sign-in";

/**
 * Redeeming a provision claim link (pre-2.0 feature, API-minted on 2.0).
 *
 * Deliberately link-only: nothing in the dashboard points here — the page
 * exists so the claim URLs handed out by POST /v1/team/provisions keep
 * working. The provision is resolved from the token server-side (the /join
 * posture), so a crafted URL cannot dress up a foreign organization's name.
 *
 * Someone signed out is sent to sign IN (not up): on cloud, Cognito owns
 * sign-up inside its own login screen; on a self-hosted deployment the login
 * screen links to signup, so a claimer without an account creates one there
 * and the stashed claim marker survives either path.
 */
export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const session = await getServerSession();
  const params = await searchParams;
  // A repeated ?token= param arrives as an array at runtime — treat anything
  // but a single string as absent rather than handing Prisma an array.
  const token = typeof params.token === "string" ? params.token : undefined;

  if (!token) {
    redirect(session ? "/" : "/auth/login");
  }

  const provision = await findPendingProvisionByToken(token);
  if (provision) {
    if (!session) {
      return <ClaimSignIn callbackUrl={`/claim?token=${token}`} />;
    }
    return <ClaimForm token={token} orgName={provision.organizationName} />;
  }

  // Expired, cancelled, already claimed, or simply not a real token — the
  // join page's breadcrumb posture rather than a bare silent redirect.
  redirect(
    session ? "/?error=claim_invalid" : "/auth/login?error=claim_invalid",
  );
}
