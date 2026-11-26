"use client";

import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useDeleteWorkspaceDialog } from "./delete-workspace-dialog";

interface Props {
  workspaceId: string;
  workspaceName: string | null;
  organizationId: string;
  isLastWorkspace: boolean;
}

export const DeleteWorkspaceButton = ({
  workspaceId,
  workspaceName,
  organizationId,
  isLastWorkspace,
}: Props) => {
  const deleteDialog = useDeleteWorkspaceDialog({
    workspaceId,
    workspaceName,
    organizationId,
  });

  return (
    <Card className="border-destructive/40 p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold">Delete workspace</h3>
          <p className="text-muted-foreground text-sm">
            Permanently removes this workspace and all of its agents, secrets,
            connections, rules, and audit logs.
            {isLastWorkspace && (
              <>
                {" "}
                You can&apos;t delete the only workspace in the organization.
              </>
            )}
          </p>
        </div>
        <div className="flex justify-end">
          {isLastWorkspace ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-not-allowed">
                  <Button variant="destructive" disabled>
                    Delete workspace
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                You can&apos;t delete the only workspace in the organization
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="destructive"
              disabled={deleteDialog.isPending}
              onClick={deleteDialog.open}
            >
              Delete workspace
            </Button>
          )}
        </div>
      </div>
      {deleteDialog.dialog}
    </Card>
  );
};
