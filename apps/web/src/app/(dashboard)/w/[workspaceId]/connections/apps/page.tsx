import { redirect } from "next/navigation";

// Cloud connections are workspace-scoped, so redirect to the workspace's connections
// page (apps tab) — NOT the OSS bare `/connections`, which would drop the
// `/w/<id>` prefix and land on a workspace-less, broken view.
export default async function AppsRedirectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/connections`);
}
