import { redirect } from "next/navigation";
import { resolveWorkspaceLanding } from "@/lib/workspaces/workspace-landing";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/**
 * A bare /w/<id> URL is the workspace's front door: it opens the first agent
 * in the sidebar (the oldest), or the create-agent page when there is none.
 * There is no workspace dashboard page any more.
 */
export default async function WorkspaceIndexPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(await resolveWorkspaceLanding(workspaceId));
}
