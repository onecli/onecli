import { redirect } from "next/navigation";
import { orgConnectionsPath } from "@/lib/navigation";

/** The apps index has no page of its own (the Apps tab IS the root), mirroring
 *  the workspace connections tree, so the "Apps" breadcrumb above an app's
 *  page lands on the grid instead of a 404. */
export default async function GlobalAppsIndexPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(orgConnectionsPath(orgId));
}
