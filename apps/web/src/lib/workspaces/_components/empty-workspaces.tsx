import { FolderPlus } from "lucide-react";
import { CreateWorkspaceButton } from "./create-workspace-button";
import type { WorkspaceQuota } from "../actions";

interface EmptyWorkspacesProps {
  quota: WorkspaceQuota;
}

export const EmptyWorkspaces = ({ quota }: EmptyWorkspacesProps) => {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16">
      <FolderPlus className="text-muted-foreground/50 mb-4 size-10" />
      <h3 className="text-lg font-medium">Create a workspace</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        Each workspace has its own agents, secrets, connections, and rules.
      </p>
      <div className="mt-4">
        <CreateWorkspaceButton quota={quota} />
      </div>
    </div>
  );
};
