import { Skeleton } from "@onecli/ui/components/skeleton";
import { RAIL_BUTTON } from "./shell-geometry";

/** The rail's agent squares while the list loads: two round marks in the
 *  agents' own frames. */
export const RailAgentSkeleton = () => (
  <>
    {[0, 1].map((i) => (
      <div key={i} aria-hidden className={RAIL_BUTTON}>
        <Skeleton className="size-8 rounded-full" />
      </div>
    ))}
  </>
);
