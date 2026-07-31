import { Suspense } from "react";
import type { Metadata } from "next";
import { AgentDetailContent } from "./_components/agent-detail-content";

export const metadata: Metadata = {
  title: "Agent",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

export default async function AgentDetailPage({ params }: Props) {
  const { agentId } = await params;
  return (
    <div className="flex flex-1 flex-col gap-6">
      <Suspense>
        <AgentDetailContent agentId={agentId} />
      </Suspense>
    </div>
  );
}
