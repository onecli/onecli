import type { Metadata } from "next";
import { EvalsSection } from "./_components/evals-section";

export const metadata: Metadata = {
  title: "Evals",
};

export default function AgentEvalsPage() {
  return <EvalsSection />;
}
