import { redirect } from "next/navigation";
import OrgWorkspacesPage from "@/lib/workspaces/page";
import { resolveOrgLanding } from "@/lib/dashboard/org-landing";
import { carrySettingsParam } from "@/lib/settings-modal/pages";

export { metadata } from "@/lib/workspaces/page";

/**
 * The org's workspaces URL forwards to the first workspace the viewer may
 * open (the list itself lives in Settings > Workspaces), an open modal
 * (`?settings=<page>`) travelling along. With no such workspace the list
 * renders, with its empty state and create button.
 */
export default async function WorkspacesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const landing = await resolveOrgLanding(orgId);
  if (landing) redirect(carrySettingsParam(landing, await searchParams));
  return <OrgWorkspacesPage />;
}
