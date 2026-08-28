"use client";

import { useEffect } from "react";

const DEFAULT_ORG_COOKIE = "onecli-default-org";

interface Props {
  workspaceId: string;
  workspaceName: string | null;
  organizationId: string;
}

export const WorkspaceNameBroadcast = ({
  workspaceId,
  workspaceName,
  organizationId,
}: Props) => {
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("onecli:workspace-context", {
        detail: { workspaceId, name: workspaceName, organizationId },
      }),
    );
  }, [workspaceId, workspaceName, organizationId]);

  useEffect(() => {
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${DEFAULT_ORG_COOKIE}=`))
      ?.split("=")[1];
    if (current !== organizationId) {
      document.cookie = `${DEFAULT_ORG_COOKIE}=${organizationId};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    }
  }, [organizationId]);

  return null;
};
