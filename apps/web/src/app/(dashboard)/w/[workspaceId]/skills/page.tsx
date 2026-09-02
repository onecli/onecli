import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/**
 * Skills moved to the agent (§3.18 as amended): they describe how ONE agent
 * works, so they are written in that agent's section. The workspace door stays
 * as a redirect to the agent list — where you pick which agent you meant —
 * rather than 404ing every existing link.
 */
export default async function WorkspaceSkillsPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(`/w/${encodeURIComponent(workspaceId)}/agents`);
}
