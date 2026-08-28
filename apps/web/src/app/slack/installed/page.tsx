import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server";
import { getUserDefaultOrg } from "@/lib/auth/default-org";
import { SlackInstalledSignIn } from "./_components/slack-installed-sign-in";
import { SlackInstalledFinish } from "./_components/slack-installed-finish";

/**
 * Landing for an install that began in SLACK — the app directory's "Add to
 * Slack" button, or the app's sharable URL.
 *
 * Those installs carry no signed state (no OneCLI session existed when the
 * install started), so the OAuth callback cannot know which organization the
 * workspace belongs to. It parks the code here instead: the person signs in,
 * and the org comes from their session.
 *
 * The Slack authorization code is short-lived and single-use, and can only be
 * redeemed with the deployment's client secret, so carrying it through the
 * browser hands out nothing on its own — the same reasoning that lets the
 * invitation token ride the URL on `/join`.
 *
 * What the code's presence in a URL DOES enable is login CSRF, so the finish
 * step below takes an explicit click rather than binding on mount — see the
 * security note in `slack-installed-finish.tsx`.
 *
 * Slack's Marketplace review exercises exactly this path, so it is a
 * submission requirement rather than a convenience.
 */
export default async function SlackInstalledPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const session = await getServerSession();
  const params = await searchParams;

  if (!params.code) {
    redirect(session ? "/" : "/auth/login");
  }

  const callbackUrl = `/slack/installed?code=${encodeURIComponent(params.code)}`;

  // Signed out: almost always a first-time visitor who found OneCLI in
  // Slack's directory, so the sign-in screen carries the code across the
  // round trip exactly as `/join` carries an invitation token.
  if (!session) return <SlackInstalledSignIn callbackUrl={callbackUrl} />;

  // The org the confirm will BIND to, named on the page so the click is
  // informed consent. It travels as an explicit scope header (the URL here
  // carries no org for the client to derive one from) and the server
  // re-fences it against the caller's active memberships — the fence, not
  // this lookup, is the authority.
  const organization = await getUserDefaultOrg();

  return (
    <SlackInstalledFinish code={params.code} organization={organization} />
  );
}
