import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * A page body while it loads: a heading, its line of copy, then rows, laid
 * out like the page blocks that replace it. It sits inside the page's own
 * scroll column (an agent section's shell, or the dashboard's page column),
 * so the width and padding are already the page's. A section that loads
 * its own data draws it too, with its own `label`, so the route's skeleton
 * and the section's are one picture.
 */
export const SectionSkeleton = ({ label = "Loading" }: { label?: string }) => (
  <div aria-busy="true" className="flex flex-col gap-6">
    <span className="sr-only">{label}</span>
    <div className="flex flex-col gap-2">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  </div>
);
