import { redirect } from "next/navigation";

// A bare /w/<id> URL has no page of its own — forward to the workspace overview so
// it never falls through to the root "Page not found". The parent
// w/[workspaceId]/layout.tsx already validates ownership and redirects invalid
// workspaces to /org before this runs.
export default async function WorkspaceIndexPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/overview`);
}
