"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { createWorkspaceAction } from "../actions";
import type { WorkspaceQuota } from "../actions";
import { validateDisplayName } from "@onecli/api/validations/display-name";
import { QuotaLimitDialog } from "@/ee/billing/_components/quota-limit-dialog";

interface CreateWorkspaceButtonProps {
  quota: WorkspaceQuota;
}

export const CreateWorkspaceButton = ({
  quota,
}: CreateWorkspaceButtonProps) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, startTransition] = useTransition();

  const atLimit =
    quota.memberCount <= 1 &&
    quota.limit !== Infinity &&
    quota.current >= quota.limit;
  const error = useMemo(() => validateDisplayName(name), [name]);
  const showError = touched && error !== null;
  const canSubmit = name.trim().length > 0 && error === null && !pending;

  const reset = () => {
    setName("");
    setTouched(false);
  };

  const handleSubmit = () => {
    setTouched(true);
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await createWorkspaceAction(name.trim());
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.push(`/w/${result.data.workspaceId}/overview`);
    });
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Plus className="size-4" />
        New workspace
      </Button>
      {atLimit ? (
        <QuotaLimitDialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) reset();
          }}
          resourceName="Workspaces"
          current={quota.current}
          limit={quota.limit}
          plan={quota.plan}
          organizationId={quota.organizationId}
        />
      ) : (
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) reset();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New workspace</DialogTitle>
              <DialogDescription>
                Each workspace has its own agents, secrets, connections, and
                rules.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-2">
              <Label htmlFor="workspace-name">Name</Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                autoFocus
                placeholder="Production"
                className={cn(showError && "border-destructive")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
              />
              <p
                className={cn(
                  "text-muted-foreground text-xs",
                  showError && "text-destructive",
                )}
              >
                {showError
                  ? error
                  : "Each workspace has its own agents, secrets, and connections."}
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!canSubmit} onClick={handleSubmit}>
                {pending ? "Creating..." : "Create workspace"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};
