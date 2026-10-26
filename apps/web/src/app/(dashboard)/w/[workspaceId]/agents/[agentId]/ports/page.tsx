import type { Metadata } from "next";
import { PortsSection } from "./_components/ports-section";

export const metadata: Metadata = {
  title: "Ports",
};

export default function AgentPortsPage() {
  return <PortsSection />;
}
