import type { Metadata } from "next";
import { MemorySection } from "./_components/memory-section";

export const metadata: Metadata = {
  title: "Memory",
};

export default function AgentMemoryPage() {
  return <MemorySection />;
}
