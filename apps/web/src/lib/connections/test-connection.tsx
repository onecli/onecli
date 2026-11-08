"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useTestConnection } from "@/hooks/use-test-connection";
import type { ConnectionTestScope } from "@/lib/api/connection-test";
import { getOrganizationId, getWorkspaceId } from "@/lib/api-fetch";
import type { PageScope } from "@/lib/api/scope";
import { ConnectionTestResult } from "./connection-test-result";

export interface TestConnectionProps {
  connectionId: string;
  scope?: ConnectionTestScope;
  pageScope?: PageScope;
  hasElevatedAccess?: boolean;
}

export const TestConnection = ({
  connectionId,
  scope,
  pageScope = "workspace",
  hasElevatedAccess = false,
}: TestConnectionProps) => {
  const test = useTestConnection();
  return (
    <div className="contents">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground dark:text-foreground/70 dark:hover:text-foreground -mx-2 h-9 justify-self-start px-2 text-xs shadow-none sm:justify-self-end"
        disabled={test.isPending}
        onClick={() =>
          test.mutate({
            connectionId,
            scope:
              scope ??
              (pageScope === "organization"
                ? { kind: "organization", organizationId: getOrganizationId() }
                : { kind: "workspace", workspaceId: getWorkspaceId() }),
          })
        }
      >
        {test.isPending && (
          <Loader2
            className="size-3 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        {test.isPending ? "Testing..." : "Test connection"}
      </Button>
      {(test.isPending || test.data || test.error) && (
        <div className="col-span-full min-w-0 pb-1">
          <ConnectionTestResult
            pending={test.isPending}
            result={test.data}
            error={test.error}
            showSuperuser={!hasElevatedAccess}
          />
        </div>
      )}
    </div>
  );
};
