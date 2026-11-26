"use client";

import { PageHeader } from "@dashboard/page-header";
import { SkillsSection } from "@/lib/skills/skills-section";
import { ScrollToHash } from "@/lib/dashboard/scroll-to-hash";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { InstructionsSection } from "../../_components/instructions-section";
import { MemorySection } from "../../memory/_components/memory-section";
import { PageBlock } from "../../_components/page-block";

/**
 * Knowledge: how the agent works and what it knows, on one page. Three
 * blocks, each the section that used to be its own page, anchored by the
 * old section name so the old URLs land on the right block
 * (`/instructions` forwards to `/knowledge#instructions`).
 */
export const KnowledgeSection = () => {
  const agent = useAgentPageAgent();
  return (
    <div className="space-y-10">
      <ScrollToHash />
      <PageHeader
        title="Knowledge"
        character="drop-book"
        description={`How ${agent.name} works and what it knows.`}
      />
      <PageBlock
        id="instructions"
        title="Instructions"
        blurb="Tone, priorities, and house rules. Applies to every chat."
      >
        <InstructionsSection heading={false} />
      </PageBlock>
      <PageBlock
        id="skills"
        title="Skills"
        blurb="Step-by-step procedures it uses when they fit."
      >
        <SkillsSection tier="agent" agentId={agent.id} />
      </PageBlock>
      <PageBlock
        id="memory"
        title="Memory"
        blurb="Things it learned while working with you. Updates on its own; you can correct it here."
      >
        <MemorySection heading={false} />
      </PageBlock>
    </div>
  );
};
