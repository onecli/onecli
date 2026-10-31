"use client";

import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AgentCreateDoor, type CreateDoorPrimary } from "./agent-create-door";
import type { AgentCreateFlow } from "./use-agent-create-flow";

interface AgentCreateControlProps {
  flow: AgentCreateFlow;
  /** Cloud composes its quota-gated primary button in here. */
  renderCreateButton?: (primary: CreateDoorPrimary) => React.ReactNode;
}

/**
 * The create door as a page control: held on a skeleton until the reads that
 * decide its PRIMARY action land (swapping a primary after paint breaks the
 * user), then the one button — plus the chevron where a second path exists —
 * and the dialogs it opens.
 */
export const AgentCreateControl = ({
  flow,
  renderCreateButton,
}: AgentCreateControlProps) => {
  if (!flow.ready) {
    return (
      <Card className="p-6">
        <Skeleton className="h-8 w-32 rounded-md" />
      </Card>
    );
  }
  return (
    <>
      <AgentCreateDoor
        door={flow.door}
        onCreateByo={flow.openByo}
        onCreateHosted={flow.openHosted}
        renderPrimary={renderCreateButton}
      />
      {flow.dialogs}
    </>
  );
};
