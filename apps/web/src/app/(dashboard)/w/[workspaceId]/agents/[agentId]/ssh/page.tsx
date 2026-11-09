import { redirectMergedSection } from "@/lib/dashboard/merged-section-redirect";

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
}

/** An old URL: SSH is a block on the agent's Settings page. */
export default async function AgentSshPage({ params }: Props) {
  const { workspaceId, agentId } = await params;
  await redirectMergedSection(workspaceId, agentId, "ssh");
}
