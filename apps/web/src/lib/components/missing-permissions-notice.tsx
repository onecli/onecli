"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { MissingPermission } from "@onecli/api/apps/missing-permissions";

export interface MissingPermissionsNoticeProps extends React.ComponentProps<"div"> {
  permissions: MissingPermission[];
  /** What the missing permissions block here, e.g. "list the folders in this
   * Drive". Omitted: a generic "some features won't work". */
  consequence?: string;
  /** Hint for the consent screen, e.g. the checkbox to tick. */
  hint?: string;
  /** Re-run the consent screen for this connection. */
  onReconnect?: () => void;
  /** The reconnect button's label (the connect popup reads "Try again"). */
  reconnectLabel?: string;
}

/**
 * The yellow "permissions weren't granted" notice: names what's missing, what
 * it breaks, and offers the reconnect that fixes it. Shared by the connection
 * card, the connect popup, and the resource picker so the wording and the
 * action never drift.
 */
export const MissingPermissionsNotice = ({
  permissions,
  consequence,
  hint,
  onReconnect,
  reconnectLabel = "Reconnect to grant",
  className,
  ...props
}: MissingPermissionsNoticeProps) => {
  if (permissions.length === 0) return null;
  const names = permissions.map((p) => `“${p.name}”`).join(", ");
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">Missing permissions</p>
          <p>
            {permissions.length === 1 ? "The permission" : "The permissions"}{" "}
            {names} {permissions.length === 1 ? "wasn't" : "weren't"} granted
            when this account was connected
            {consequence
              ? `, so OneCLI can't ${consequence}.`
              : ", so features that need them won't work."}
          </p>
          <ul className="text-amber-800/80 dark:text-amber-300/80">
            {permissions.map((p) => (
              <li key={p.scope}>
                <span className="font-medium">{p.name}</span>: {p.description}
              </li>
            ))}
          </ul>
          <p className="text-amber-800/80 dark:text-amber-300/80">
            {hint ??
              "Reconnect and allow every permission on the consent screen."}{" "}
            If the option isn&apos;t offered, your workspace admin may have
            restricted it.
          </p>
        </div>
      </div>
      {onReconnect && (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onReconnect}
          >
            <RefreshCw className="size-3" aria-hidden />
            {reconnectLabel}
          </Button>
        </div>
      )}
    </div>
  );
};
