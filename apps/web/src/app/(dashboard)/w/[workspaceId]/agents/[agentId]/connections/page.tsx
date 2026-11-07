import { Suspense } from "react";
import type { Metadata } from "next";
import { AgentConnectionsSection } from "../_components/agent-connections-section";
import { AttachParamDialog } from "../_components/attach-param-dialog";

export const metadata: Metadata = {
  title: "Connections",
};

interface Props {
  params: Promise<{ agentId: string }>;
}

/** Reads `?tab=`, the `?connection=&manage=1` deep link, and the gateway's
 *  `?attach=<provider>` link (an account that is off for this agent), so it
 *  needs the Suspense boundary `useSearchParams` requires. */
export default async function AgentConnectionsPage({ params }: Props) {
  const { agentId } = await params;
  return (
    <Suspense>
      <AgentConnectionsSection agentId={agentId} />
      <AttachParamDialog />
    </Suspense>
  );
}
