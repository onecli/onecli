import { redirect } from "next/navigation";
import { orgHomePath } from "@/lib/navigation";
import { resolveOrgLanding } from "@/lib/dashboard/org-landing";
import { carrySettingsParam } from "@/lib/settings-modal/pages";

// A bare /org/<id> URL has no page of its own. The parent org/[orgId]/
// layout.tsx already validates membership and redirects non-members to /org
// before this runs. The org's home is its first visible workspace's first
// agent, an open modal (`?settings=<page>`) travelling along; with no
// workspace to land in, the org's workspaces page.
export default async function OrgIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const landing = await resolveOrgLanding(orgId);
  redirect(
    landing
      ? carrySettingsParam(landing, await searchParams)
      : orgHomePath(orgId),
  );
}
