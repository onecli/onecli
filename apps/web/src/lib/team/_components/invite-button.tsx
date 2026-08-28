"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  getResourceQuota,
  type ResourceQuota,
} from "@/ee/billing/quota-actions";
import { QuotaLimitDialog } from "@/ee/billing/_components/quota-limit-dialog";
import { InviteDialog } from "./invite-dialog";

/**
 * Invite someone to the organization.
 *
 * A plain button rather than a split one: the dropdown existed solely to host
 * placeholder provisioning, which invitations replaced.
 */
export const InviteButton = () => {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [quota, setQuota] = useState<ResourceQuota | null>(null);
  const [quotaOpen, setQuotaOpen] = useState(false);

  useEffect(() => {
    // Fail-open: if the quota read fails the button stays usable and the
    // server assert backstops with its own error toast.
    getResourceQuota("Members")
      .then(setQuota)
      .catch(() => {});
  }, []);

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          // The server assert remains the source of truth; this is UX.
          if (quota?.atLimit) {
            setQuotaOpen(true);
            return;
          }
          setInviteOpen(true);
        }}
      >
        <UserPlus className="size-3.5" />
        Invite
      </Button>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      {quota && (
        <QuotaLimitDialog
          open={quotaOpen}
          onOpenChange={setQuotaOpen}
          resourceName="Members"
          current={quota.current}
          limit={quota.limit}
          plan={quota.plan}
          organizationId={quota.organizationId}
        />
      )}
    </>
  );
};
