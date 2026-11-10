import { redirect } from "next/navigation";
import { resolveWorkspaceLanding } from "@/lib/workspaces/workspace-landing";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/**
 * `/files` has no listing: the section exists for the one-file page a link
 * from outside the web lands on (`/files/<id>?c=`). Someone who trims the URL
 * back to the section lands on the workspace's first agent (where its front
 * door lands, in one hop) instead of a 404.
 */
export default async function WorkspaceFilesPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(await resolveWorkspaceLanding(workspaceId));
}
