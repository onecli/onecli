import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { AgentsContent } from "./_components/agents-content";

export const metadata: Metadata = {
  title: "Agents",
};

export default function AgentsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 max-w-5xl">
      <PageHeader
        title="Agents"
        description="Manage agents that connect to the gateway and receive injected credentials."
      />
      <Suspense>
        <AgentsContent />
      </Suspense>
    </div>
  );
}
