import type { LucideIcon } from "lucide-react";
import { Lock } from "lucide-react";

/**
 * The head of each panel on the SSO page: an icon and a title, one line on
 * what the panel does, and the panel's action on the right. A rule under
 * it sets the head apart from what the panel holds.
 */
export const SsoPanelHeader = ({
  icon: Icon,
  title,
  description,
  action,
  locked = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  /** The plan locks the feature: a lock leads the title. */
  locked?: boolean;
}) => (
  <div className="flex items-start justify-between gap-4 border-b pb-4">
    <div className="min-w-0 space-y-1">
      <h2 className="flex items-center gap-2 text-base font-medium">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        {title}
        {locked && (
          <Lock
            className="text-muted-foreground size-3.5"
            role="img"
            aria-label="Locked"
          />
        )}
      </h2>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);
