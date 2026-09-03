import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { hasPendingMarketplaceToken } from "@/ee/billing/aws-marketplace/actions";
import { IS_CLOUD } from "@/lib/env";
import { RegisterForm } from "./register-form";

/**
 * AWS Marketplace registration (plans/aws-marketplace-listing.md §3): the
 * buyer arrives here from /aws-marketplace/fulfill with the registration
 * token parked in an httpOnly cookie. Signed out, they go through login
 * first (the cookie survives the round trip); signed in, an org admin
 * confirms which organization the subscription activates on.
 *
 * HOSTED ONLY (same law as the fulfill route and the /v1 intake's
 * cloudOnly): AWS Marketplace billing is a hosted-platform surface, so on
 * a self-host this page does not exist.
 */
export default async function AwsMarketplaceRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!IS_CLOUD) notFound();

  const [session, params, hasToken] = await Promise.all([
    getServerSession(),
    searchParams,
    hasPendingMarketplaceToken(),
  ]);

  if (!session) {
    redirect(
      `/auth/login?callbackUrl=${encodeURIComponent("/aws-marketplace/register")}`,
    );
  }

  const initialError =
    params.error === "missing-token"
      ? "AWS did not pass a registration token. Return to AWS Marketplace and click 'Set up your account' again."
      : !hasToken
        ? "No AWS Marketplace registration in progress (the link may have expired). Return to AWS Marketplace and click 'Set up your account' again."
        : null;

  return <RegisterForm initialError={initialError} />;
}
