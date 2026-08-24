import type { Metadata } from "next";
import { ModelsSection } from "../_components/models-section";

export const metadata: Metadata = {
  title: "Models",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/**
 * What the agent runs, and the keys that decide it — in that order, because
 * the key is the cause and the model is the consequence (§3.10). The section
 * carries its own "Add LLM key" door (create-then-attach), so a dead key is
 * fixable right here.
 */
export default async function AgentModelsPage({ params }: Props) {
  const { agentId } = await params;
  return <ModelsSection agentId={agentId} />;
}
