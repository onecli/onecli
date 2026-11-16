import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { chooserGridClassName, chooserTileClassName } from "./chooser-layout";

/**
 * The agent's grant rows while their reads land, in the shape of the rows
 * that replace them: an icon tile, a name over a caption, the switch on the
 * right, at the real row's height (`py-3` round a 36px tile), so the list
 * fills in rather than jumping from a centred spinner. In the chooser the
 * same pieces sit in the chooser's tiles.
 */
export const GrantRowsSkeleton = ({
  label,
  chooser = false,
}: {
  /** What is loading, for screen readers. */
  label: string;
  chooser?: boolean;
}) => (
  <div aria-busy="true" className={chooser ? chooserGridClassName : "divide-y"}>
    <span className="sr-only">{label}</span>
    {[0, 1, 2].map((i) => (
      <div
        key={i}
        aria-hidden
        className={cn(
          "flex items-center justify-between",
          chooser ? chooserTileClassName : "gap-4 py-3",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-48 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-3.5 w-6 shrink-0 rounded-full" />
      </div>
    ))}
  </div>
);
