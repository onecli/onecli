/** A small numbered badge for an ordered instruction list. */
export const StepNumber = ({ n }: { n: number }) => (
  <span
    aria-hidden
    className="bg-muted text-foreground flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
  >
    {n}
  </span>
);
