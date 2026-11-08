import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/**
 * The Overview dashboard is gone. Old bookmarks and links still in the wild
 * (emails, docs, CLI output) forward to the workspace's front door instead of
 * a 404.
 */
export default async function LegacyOverviewPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(`/w/${encodeURIComponent(workspaceId)}`);
}
