import { Skeleton } from "@onecli/ui/components/skeleton";

/**
 * What a modal page shows while its body streams in: the banner's height,
 * then a few rows. Same box as the real header, so nothing jumps when the
 * page lands.
 */
export const SettingsBodySkeleton = () => (
  <div aria-hidden className="flex flex-col gap-6">
    <Skeleton className="h-[86px] w-full rounded-lg" />
    <div className="flex flex-col gap-3">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-2/3" />
    </div>
  </div>
);
