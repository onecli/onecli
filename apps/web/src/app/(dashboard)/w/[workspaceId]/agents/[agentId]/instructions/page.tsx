import type { Metadata } from "next";
import { InstructionsSection } from "../_components/instructions-section";

export const metadata: Metadata = {
  title: "Instructions",
};

export default function AgentInstructionsPage() {
  return <InstructionsSection />;
}
