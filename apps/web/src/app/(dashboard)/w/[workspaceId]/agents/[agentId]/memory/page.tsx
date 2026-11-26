import { redirectMergedSection } from "@/lib/dashboard/merged-section-redirect";

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
}

/** An old URL: Memory is a block on the agent's Knowledge page. */
export default async function AgentMemoryPage({ params }: Props) {
  const { workspaceId, agentId } = await params;
  await redirectMergedSection(workspaceId, agentId, "memory");
}
