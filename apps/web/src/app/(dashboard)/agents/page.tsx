import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { POLICY_EDITING_ENABLED } from "@/lib/env";
import { AgentsContent } from "./_components/agents-content";

export const metadata: Metadata = {
  title: "Agents",
};

export default function AgentsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Manage agents that connect to the gateway and receive injected credentials."
      />
      <Suspense>
        {/* Step 9.7b: flips the credential-access editor to a read-only
            Policy reflection in the EE editions; OSS keeps its legacy editor
            (the reflection seam resolves to a null stub there). */}
        <AgentsContent policyEditingEnabled={POLICY_EDITING_ENABLED} />
      </Suspense>
    </div>
  );
}
