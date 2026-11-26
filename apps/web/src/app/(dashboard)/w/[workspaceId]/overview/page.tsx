import { redirect } from "next/navigation";
import { resolveWorkspaceLanding } from "@/lib/workspaces/workspace-landing";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/**
 * The Overview dashboard is gone. Old bookmarks and links still in the wild
 * (emails, docs, CLI output) forward to the workspace's first agent (where
 * its front door lands, in one hop) instead of a 404.
 */
export default async function LegacyOverviewPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(await resolveWorkspaceLanding(workspaceId));
}
