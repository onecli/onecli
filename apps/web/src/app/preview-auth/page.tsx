import { getServerSession } from "@/lib/auth/server";
import { PreviewAuthHandoff } from "./_components/preview-auth-handoff";
import { PreviewAuthSignIn } from "./_components/preview-auth-sign-in";

/**
 * The preview login handoff (plans/sandbox-ports.md §6). A preview relay
 * sends a signed-out browser here with `?host=<preview host>&path=<path>`.
 *
 * Signed in: the client POSTs to `/v1/preview-auth` with the viewer's normal
 * credentials and follows the returned ticket URL. Signed out: the return is
 * parked in the post-auth channel and the normal login runs, whichever
 * provider the deployment uses. Both arms work on split hosts because the
 * page lives on the dashboard and calls the api like every other page.
 */
export default async function PreviewAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ host?: string; path?: string }>;
}) {
  const session = await getServerSession();
  const { host = "", path = "/" } = await searchParams;
  const callbackUrl = `/preview-auth?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`;
  if (!session) return <PreviewAuthSignIn callbackUrl={callbackUrl} />;
  return <PreviewAuthHandoff host={host} path={path} />;
}
