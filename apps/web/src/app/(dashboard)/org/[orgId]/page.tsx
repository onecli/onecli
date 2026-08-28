import { redirect } from "next/navigation";

// A bare /org/<id> URL has no page of its own — forward to the org's workspaces
// list so it never falls through to the root "Page not found". The parent
// org/[orgId]/layout.tsx already validates membership and redirects non-members
// to /org before this runs.
export default async function OrgIndexPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/org/${orgId}/workspaces`);
}
