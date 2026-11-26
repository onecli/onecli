import type { ReactNode } from "react";
import { AppIcon } from "@/lib/components/app-icon";

/**
 * One row of the chat's connect card: the app's chip, its name over one
 * status line, and at most ONE action at the right edge. Every row of the
 * card (app or channel, in every state) is this layout, so the names, the
 * status lines and the buttons sit on the same three columns.
 *
 * `text-start` is set here, not inherited: the card renders inside
 * centered surfaces (the empty-thread welcome), and a row must never pick
 * their alignment up.
 */
export const ConnectCardRow = ({
  icon,
  darkIcon,
  name,
  status,
  action,
}: {
  icon: string;
  darkIcon?: string;
  name: string;
  /** One line; truncated, never wrapped under the action. */
  status: ReactNode;
  action?: ReactNode;
}) => (
  <div className="flex items-center gap-3 px-4 py-3 text-start">
    <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:border-white/10 dark:bg-white/10">
      <AppIcon icon={icon} darkIcon={darkIcon} name={name} size={18} />
    </div>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium">{name}</p>
      <div className="truncate text-xs">{status}</div>
    </div>
    {action && <div className="flex shrink-0 items-center">{action}</div>}
  </div>
);
