"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useResourceQuota } from "@/ee/billing/use-plan-usage";
import { QuotaLimitDialog } from "@/ee/billing/_components/quota-limit-dialog";
import type { CreateDoorPrimary } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agent-create-door";

interface CreateAgentButtonProps extends CreateDoorPrimary {
  /** Render a different trigger (the sidebar's "New agent" row) behind the
   *  same quota gate. Receives the gated click handler. */
  renderTrigger?: (onClick: () => void) => React.ReactNode;
}

/** The create door's primary button, gated on the org's agent quota. Label
 *  and shape come from the door (which knows whether it is half of a split
 *  control); only the quota check is ours. The quota is read off the plan
 *  usage the header already holds, so the sidebar row on every page costs
 *  no request of its own. */
export const CreateAgentButton = ({
  onClick,
  label,
  className,
  renderTrigger,
}: CreateAgentButtonProps) => {
  const quota = useResourceQuota("Agents");
  const [quotaOpen, setQuotaOpen] = useState(false);

  const handleClick = () => {
    if (quota?.atLimit) {
      setQuotaOpen(true);
      return;
    }
    onClick();
  };

  return (
    <>
      {renderTrigger ? (
        renderTrigger(handleClick)
      ) : (
        <Button size="sm" onClick={handleClick} className={className}>
          <Plus className="size-3.5" />
          {label}
        </Button>
      )}
      {quota && (
        <QuotaLimitDialog
          open={quotaOpen}
          onOpenChange={setQuotaOpen}
          resourceName="Agents"
          current={quota.current}
          limit={quota.limit}
          plan={quota.plan}
          organizationId={quota.organizationId}
        />
      )}
    </>
  );
};
