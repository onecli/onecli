"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  getResourceQuota,
  type ResourceQuota,
} from "@/ee/billing/quota-actions";
import { QuotaLimitDialog } from "@/ee/billing/_components/quota-limit-dialog";
import type { CreateDoorPrimary } from "@/app/(dashboard)/w/[workspaceId]/agents/_components/agent-create-door";

/** The create door's primary button, gated on the org's agent quota. Label
 *  and shape come from the door (which knows whether it is half of a split
 *  control); only the quota check is ours. */
export const CreateAgentButton = ({
  onClick,
  label,
  className,
}: CreateDoorPrimary) => {
  const [quota, setQuota] = useState<ResourceQuota | null>(null);
  const [quotaOpen, setQuotaOpen] = useState(false);

  useEffect(() => {
    getResourceQuota("Agents").then(setQuota);
  }, []);

  const handleClick = () => {
    if (quota?.atLimit) {
      setQuotaOpen(true);
      return;
    }
    onClick();
  };

  return (
    <>
      <Button size="sm" onClick={handleClick} className={className}>
        <Plus className="size-3.5" />
        {label}
      </Button>
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
