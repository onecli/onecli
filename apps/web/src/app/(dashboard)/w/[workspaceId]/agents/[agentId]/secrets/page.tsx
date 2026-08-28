import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
}

/** Secrets are the Custom tab of the agent's Connections section now. */
export default async function AgentSecretsPage({ params }: Props) {
  const { workspaceId, agentId } = await params;
  // Route params arrive DECODED — encode them back (the house rule).
  redirect(
    `/w/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/connections?tab=custom`,
  );
}
