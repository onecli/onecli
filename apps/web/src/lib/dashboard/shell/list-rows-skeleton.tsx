import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * A list of rows while it loads, for a list that sits under a heading the
 * page already drew (the Knowledge page's Skills and Memory blocks, the
 * Activity tabs under their filters): the rows fill in where the skeleton
 * stood, instead of a centred spinner giving way to a list. A whole
 * section loading draws `SectionSkeleton` instead, heading included. The
 * rows are the common row's height (a title over a caption) in a bordered
 * list.
 */
export const ListRowsSkeleton = ({
  label,
  rows = 3,
}: {
  /** What is loading, for screen readers. */
  label: string;
  rows?: number;
}) => (
  <div aria-busy="true" className="divide-y rounded-lg border">
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} aria-hidden className="flex items-center gap-4 px-4 py-3">
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        <Skeleton className="h-6 w-16 shrink-0" />
      </div>
    ))}
  </div>
);
