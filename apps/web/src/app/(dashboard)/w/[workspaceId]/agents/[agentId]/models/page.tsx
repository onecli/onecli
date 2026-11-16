import { redirectMergedSection } from "@/lib/dashboard/merged-section-redirect";

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
}

/** An old URL: Models (the agent's model and the keys that decide it) is a
 *  block on the agent's Settings page. */
export default async function AgentModelsPage({ params }: Props) {
  const { workspaceId, agentId } = await params;
  await redirectMergedSection(workspaceId, agentId, "models");
}
