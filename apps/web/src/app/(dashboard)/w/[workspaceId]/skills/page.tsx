import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/**
 * Skills moved to the agent (§3.18 as amended): they describe how ONE agent
 * works, so they are written in that agent's section. The workspace door stays
 * as a redirect to the workspace's front door (its first agent, every agent a
 * row in the sidebar) rather than 404ing every existing link.
 */
export default async function WorkspaceSkillsPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(`/w/${encodeURIComponent(workspaceId)}`);
}
