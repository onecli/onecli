"use client";

export interface DirectionHeaderProps {
  inbound: string;
  outbound: string;
  /** Channels only: the "what it hears" column, ahead of the two directions. */
  listen?: string;
}

/**
 * The column labels over a group of two-way rows: which question each
 * badge answers. Hidden on narrow screens, where every cell carries its
 * own label instead. The trailing spacer matches the row's `…` column.
 */
export const DirectionHeader = ({
  inbound,
  outbound,
  listen,
}: DirectionHeaderProps) => (
  <div
    className="text-muted-foreground hidden items-center gap-3 border-b py-2 text-xs sm:flex"
    aria-hidden
  >
    <span className="flex-1" />
    {/* Mirrors ContactRowFrame: status cells, gap-1, then the `…` column. */}
    <div className="flex items-center gap-1">
      <div className="flex items-center gap-2">
        {listen && <span className="w-40 px-2 text-right">{listen}</span>}
        <span className="w-40 px-2 text-right">{inbound}</span>
        <span className="w-40 px-2 text-right">{outbound}</span>
      </div>
      <span className="w-9" />
    </div>
  </div>
);
