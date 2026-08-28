"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  getResourceQuota,
  type ResourceQuota,
} from "@/ee/billing/quota-actions";
import { QuotaLimitDialog } from "@/ee/billing/_components/quota-limit-dialog";

interface CreateSecretButtonProps {
  onCreate: () => void;
  label: string;
}

export const CreateSecretButton = ({
  onCreate,
  label,
}: CreateSecretButtonProps) => {
  const [quota, setQuota] = useState<ResourceQuota | null>(null);
  const [quotaOpen, setQuotaOpen] = useState(false);

  useEffect(() => {
    getResourceQuota("Secrets").then(setQuota);
  }, []);

  const handleClick = () => {
    if (quota?.atLimit) {
      setQuotaOpen(true);
    } else {
      onCreate();
    }
  };

  return (
    <>
      <Button size="sm" onClick={handleClick}>
        <Plus className="size-3.5" />
        {label}
      </Button>
      {quota && (
        <QuotaLimitDialog
          open={quotaOpen}
          onOpenChange={setQuotaOpen}
          resourceName="Secrets"
          current={quota.current}
          limit={quota.limit}
          plan={quota.plan}
          organizationId={quota.organizationId}
        />
      )}
    </>
  );
};
