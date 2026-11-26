import type { Metadata } from "next";
import { KnowledgeSection } from "./_components/knowledge-section";

export const metadata: Metadata = {
  title: "Knowledge",
};

/** Instructions, Skills and Memory on one page. Their old URLs forward
 *  here, each to its own block. */
export default function AgentKnowledgePage() {
  return <KnowledgeSection />;
}
