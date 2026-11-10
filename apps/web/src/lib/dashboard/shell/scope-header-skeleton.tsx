import { Skeleton } from "@onecli/ui/components/skeleton";
import { SIDEBAR_SCOPE_BOX, SIDEBAR_SCOPE_LABEL } from "./shell-geometry";

/**
 * The sidebar's bottom block while the org list loads: the "Organization"
 * label and the line under it stay put (they never change), and only the
 * name is a placeholder, in a row the height of the menu button (a 20px
 * line and py-1.5) that replaces it.
 */
export const ScopeHeaderSkeleton = () => (
  <div aria-hidden>
    <p className={SIDEBAR_SCOPE_LABEL}>Organization</p>
    <div className={SIDEBAR_SCOPE_BOX}>
      <div className="flex h-8 items-center px-2">
        <Skeleton className="h-4 w-28" />
      </div>
    </div>
  </div>
);
