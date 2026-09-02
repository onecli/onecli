"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { useRenameWorkspace } from "@/hooks/use-workspaces";
import { validateDisplayName } from "@onecli/api/validations/display-name";

interface Props {
  workspaceId: string;
  currentName: string | null;
}

export const RenameWorkspaceForm = ({ workspaceId, currentName }: Props) => {
  const [name, setName] = useState(currentName ?? "");
  const [touched, setTouched] = useState(false);
  const renameWorkspace = useRenameWorkspace();

  const error = useMemo(() => validateDisplayName(name), [name]);
  const showError = touched && error !== null;
  const dirty =
    name.trim() !== (currentName ?? "").trim() && name.trim() !== "";
  const canSubmit = dirty && error === null && !renameWorkspace.isPending;

  const handleSubmit = async () => {
    setTouched(true);
    if (!canSubmit) return;
    try {
      const workspace = await renameWorkspace.mutateAsync({
        id: workspaceId,
        name: name.trim(),
      });
      window.dispatchEvent(
        new CustomEvent("onecli:workspace-context", {
          detail: { workspaceId, name: workspace.name },
        }),
      );
      toast.success("Workspace renamed");
    } catch {
      // the hook already toasts the server reason
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold">Workspace name</h3>
          <p className="text-muted-foreground text-sm">
            Shown in the sidebar, breadcrumb, and workspace list.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="workspace-name">Name</Label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
            disabled={renameWorkspace.isPending}
            placeholder="Production"
            className={cn(showError && "border-destructive")}
          />
          {showError && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {renameWorkspace.isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </Card>
  );
};
