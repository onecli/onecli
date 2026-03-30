"use client";

import { Check, Eye, Minus, Pencil } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { Card } from "@onecli/ui/components/card";
import { cn } from "@onecli/ui/lib/utils";
import type { OAuthPermission } from "@/lib/apps/types";

interface PermissionsListProps {
  permissions: OAuthPermission[];
  grantedScopes?: string[];
}

export const PermissionsList = ({
  permissions,
  grantedScopes,
}: PermissionsListProps) => {
  const isConnected = !!grantedScopes;
  const grantedSet = new Set(grantedScopes ?? []);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">
        {isConnected ? "Permissions" : "Permissions requested"}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {permissions.map((perm) => {
          const granted = isConnected ? grantedSet.has(perm.scope) : null;

          return (
            <Card
              key={perm.scope}
              className={cn(
                "px-4 py-3",
                granted === false &&
                  "border-amber-200 bg-amber-50/30 dark:border-amber-900 dark:bg-amber-950/10",
              )}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  {granted === true ? (
                    <Check className="size-4 text-brand" />
                  ) : granted === false ? (
                    <Minus className="size-4 text-amber-500" />
                  ) : perm.access === "read" ? (
                    <Eye className="size-4 text-muted-foreground" />
                  ) : (
                    <Pencil className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-sm font-medium",
                          granted === false &&
                            "text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {perm.name}
                      </span>
                      {granted === true && (
                        <Badge
                          variant="secondary"
                          className="px-1.5 py-0 text-[10px]"
                        >
                          Granted
                        </Badge>
                      )}
                      {granted === false && (
                        <Badge
                          variant="outline"
                          className="px-1.5 py-0 text-[10px] text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-700"
                        >
                          Not granted
                        </Badge>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {perm.access === "read" ? "Read" : "Read & write"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {perm.description}
                  </p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
