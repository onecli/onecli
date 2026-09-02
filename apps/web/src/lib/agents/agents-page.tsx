"use client";

import { Suspense } from "react";
import { PageHeader } from "@dashboard/page-header";
import { AgentsContent } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agents-content";
import { CreateAgentButton } from "./_components/create-agent-button";

// The cloud agents page: the shared content with the EE create button composed
// in. A client component because the composition is a render prop (functions
// can't cross the RSC boundary).
export default function CloudAgentsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Manage agents that connect to the gateway and receive injected credentials."
      />
      <Suspense>
        <AgentsContent
          renderCreateButton={(primary) => <CreateAgentButton {...primary} />}
        />
      </Suspense>
    </div>
  );
}
