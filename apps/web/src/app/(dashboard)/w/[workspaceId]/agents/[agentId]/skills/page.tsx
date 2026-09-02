import type { Metadata } from "next";
import { SkillsSection } from "@/lib/skills/skills-section";

export const metadata: Metadata = {
  title: "Skills",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/** Skills are a property of the AGENT (§3.18 as amended): this section shows
 *  what this agent carries — its own rows plus the tiers it inherits. */
export default async function AgentSkillsPage({ params }: Props) {
  const { agentId } = await params;
  return <SkillsSection tier="agent" agentId={agentId} />;
}
