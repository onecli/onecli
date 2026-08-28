"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Label } from "@onecli/ui/components/label";
import { Switch } from "@onecli/ui/components/switch";
import { changeTeamMemberRole } from "@/ee/team/actions";
import { usePlanGate } from "@/lib/plan-gate";
import { useUpdateOrgMember } from "@/hooks/use-org-members";
import { RoleSelect } from "@/lib/team/_components/role-select";

interface ManageAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  email: string;
  currentRole: "admin" | "member";
  currentSsoExempt: boolean;
  /** Role is governed by a group→role mapping (step 15) — lock the control. */
  roleManagedByIdp?: boolean;
}

export const ManageAccessDialog = ({
  open,
  onOpenChange,
  userId,
  email,
  currentRole,
  currentSsoExempt,
  roleManagedByIdp,
}: ManageAccessDialogProps) => {
  const router = useRouter();
  const planGate = usePlanGate();
  const [role, setRole] = useState<"admin" | "member">(currentRole);
  const [ssoExempt, setSsoExempt] = useState(currentSsoExempt);
  const [pending, startTransition] = useTransition();
  const updateMember = useUpdateOrgMember();

  const roleDirty = role !== currentRole;
  const exemptDirty = ssoExempt !== currentSsoExempt;
  const isDirty = roleDirty || exemptDirty;
  const busy = pending || updateMember.isPending;

  const handleSave = () => {
    if (!isDirty) return;
    startTransition(async () => {
      if (roleDirty) {
        const result = await changeTeamMemberRole(userId, role);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
      }
      if (exemptDirty) {
        try {
          await updateMember.mutateAsync({ userId, input: { ssoExempt } });
        } catch {
          // useUpdateOrgMember already toasts the server reason.
          return;
        }
      }
      toast.success("Access updated");
      onOpenChange(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>Update access for {email}.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <RoleSelect
              id="manage-role"
              value={role}
              onValueChange={(next) => {
                // Role management is RBAC (#66) — licensed.
                if (planGate.guard("rbac")) return;
                setRole(next);
              }}
              disabled={roleManagedByIdp}
            />
            {roleManagedByIdp && (
              <p className="text-muted-foreground text-xs">
                This member&rsquo;s role is managed by your identity provider.
                Change it through the group&rsquo;s role mapping.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor="manage-sso-exempt">
                SSO break-glass exemption
              </Label>
              <p className="text-muted-foreground text-xs">
                Can sign in without SSO when the organization requires it.
              </p>
            </div>
            <Switch
              id="manage-sso-exempt"
              checked={ssoExempt}
              onCheckedChange={(next) => {
                // Break-glass exemptions belong to SSO enforcement (#75).
                if (planGate.guard("sso")) return;
                setSsoExempt(next);
              }}
              disabled={busy}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={busy}
            disabled={!isDirty || busy}
          >
            {busy ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
