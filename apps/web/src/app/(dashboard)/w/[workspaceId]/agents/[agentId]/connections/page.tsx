import { Suspense } from "react";
import type { Metadata } from "next";
import { AgentConnectionsSection } from "../_components/agent-connections-section";

export const metadata: Metadata = {
  title: "Connections",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/** Reads `?tab=` and the `?connection=&manage=1` deep link, so it needs the
 *  Suspense boundary `useSearchParams` requires. */
export default async function AgentConnectionsPage({ params }: Props) {
  const { agentId } = await params;
  return (
    <Suspense>
      <AgentConnectionsSection agentId={agentId} />
    </Suspense>
  );
}
